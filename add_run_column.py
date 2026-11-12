#!/usr/bin/env python3
"""
Update player_play and game_tracking Parquet and CSV files with a boolean 'run' column.

Logic:
1. In player_play:
   run = (pass_result is null) AND (dropback_duration is null)
   (stored as boolean True/False)

2. In game_tracking files (per player folder and root files):
   Select game_tracking by game_id:
     - game_id < 2024051754 -> game_tracking_2023
     - game_id > 2025041754 -> game_tracking_2025
     - otherwise            -> game_tracking_2024
   Match on (game_id, play_id) to assign the player's 'run' boolean value.
"""

import sys
import time
from pathlib import Path
import polars as pl
from concurrent.futures import ProcessPoolExecutor, as_completed

BASE_DIR = Path(__file__).resolve().parent

def compute_run_expr():
    return (pl.col("pass_result").is_null() & pl.col("dropback_duration").is_null()).alias("run")

def process_player_folder(folder_path: Path):
    """
    Process player_play.parquet and all game_tracking_*.parquet files in a single player folder.
    """
    pp_file = folder_path / "player_play.parquet"
    if not pp_file.exists():
        return 0, 0

    try:
        pp_df = pl.read_parquet(pp_file)
    except Exception as e:
        print(f"Error reading {pp_file}: {e}", file=sys.stderr)
        return 0, 0

    # Add or update 'run' column
    pp_df = pp_df.with_columns(compute_run_expr())
    pp_df.write_parquet(pp_file, compression="zstd")

    # Build lookup table (game_id, play_id) -> run
    lookup = pp_df.select(["game_id", "play_id", "run"]).unique(subset=["game_id", "play_id"])

    gt_updated = 0
    # Process game_tracking_*.parquet in the same folder
    for year, fname in [
        (2023, "game_tracking_2023.parquet"),
        (2024, "game_tracking_2024.parquet"),
        (2025, "game_tracking_2025.parquet"),
    ]:
        gt_file = folder_path / fname
        if not gt_file.exists():
            continue

        try:
            gt_df = pl.read_parquet(gt_file)
            # Filter lookup according to game_id rules
            if year == 2023:
                filt = pl.col("game_id") < 2024051754
            elif year == 2025:
                filt = pl.col("game_id") > 2025041754
            else:
                filt = (pl.col("game_id") >= 2024051754) & (pl.col("game_id") <= 2025041754)

            year_lookup = lookup.filter(filt)
            
            # If 'run' already exists in gt_df, drop it first to avoid duplicate column conflict
            if "run" in gt_df.columns:
                gt_df = gt_df.drop("run")

            gt_joined = gt_df.join(year_lookup, on=["game_id", "play_id"], how="left")
            gt_joined.write_parquet(gt_file, compression="zstd")
            gt_updated += 1
        except Exception as e:
            print(f"Error processing {gt_file}: {e}", file=sys.stderr)

    return 1, gt_updated

def update_root_files():
    print("Updating root level files...")
    
    # Root player_play.parquet
    root_pp_parquet = BASE_DIR / "player_play.parquet"
    if root_pp_parquet.exists():
        print(f"Updating {root_pp_parquet.name}...")
        df = pl.read_parquet(root_pp_parquet)
        df = df.with_columns(compute_run_expr())
        df.write_parquet(root_pp_parquet, compression="zstd")
        print("Done.")

    # Root player_play.csv (out-of-core streaming read/write)
    root_pp_csv = BASE_DIR / "player_play.csv"
    if root_pp_csv.exists():
        print(f"Updating {root_pp_csv.name}...")
        df = pl.scan_csv(root_pp_csv, infer_schema_length=20000, null_values=["NA", "null", ""]).with_columns(compute_run_expr()).collect()
        df.write_csv(root_pp_csv)
        print("Done.")

    # Also root game_tracking files if needed
    for year, fname in [
        (2023, "game_tracking_2023.parquet"),
        (2024, "game_tracking_2024.parquet"),
        (2025, "game_tracking_2025.parquet"),
    ]:
        gt_parquet = BASE_DIR / fname
        if gt_parquet.exists() and root_pp_parquet.exists():
            print(f"Updating root {fname}...")
            pp_sub = pl.read_parquet(root_pp_parquet, columns=["game_id", "play_id", "nfl_id", "run"]).unique(subset=["game_id", "play_id", "nfl_id"])
            if year == 2023:
                filt = pl.col("game_id") < 2024051754
            elif year == 2025:
                filt = pl.col("game_id") > 2025041754
            else:
                filt = (pl.col("game_id") >= 2024051754) & (pl.col("game_id") <= 2025041754)
            year_sub = pp_sub.filter(filt)
            
            gt_df = pl.read_parquet(gt_parquet)
            if "run" in gt_df.columns:
                gt_df = gt_df.drop("run")
            gt_joined = gt_df.join(year_sub, on=["game_id", "play_id", "nfl_id"], how="left")
            gt_joined.write_parquet(gt_parquet, compression="zstd")
            print(f"Done root {fname}.")

def main():
    start_time = time.time()
    
    # 1. Update root files
    update_root_files()

    # 2. Collect all player folders across tracking_by_position and combine_tracking_by_position
    target_roots = [
        BASE_DIR / "tracking_by_position",
        BASE_DIR / "combine_tracking_by_position",
    ]
    
    player_folders = []
    for root in target_roots:
        if root.exists():
            for pos_dir in root.iterdir():
                if pos_dir.is_dir():
                    for player_dir in pos_dir.iterdir():
                        if player_dir.is_dir() and (player_dir / "player_play.parquet").exists():
                            player_folders.append(player_dir)

    print(f"\nFound {len(player_folders)} player folders to process across position directories.")

    total_pp = 0
    total_gt = 0

    # Process in parallel using ProcessPoolExecutor
    with ProcessPoolExecutor() as executor:
        futures = {executor.submit(process_player_folder, f): f for f in player_folders}
        for i, future in enumerate(as_completed(futures), 1):
            pp_done, gt_done = future.result()
            total_pp += pp_done
            total_gt += gt_done
            if i % 100 == 0 or i == len(player_folders):
                elapsed = time.time() - start_time
                print(f"[{i}/{len(player_folders)}] folders processed... (PP files: {total_pp}, GT files: {total_gt}) [{elapsed:.1f}s]")

    elapsed = time.time() - start_time
    print(f"\nAll files successfully updated in {elapsed:.1f}s!")
    print(f"Total player_play files updated: {total_pp}")
    print(f"Total game_tracking files updated: {total_gt}")

if __name__ == "__main__":
    main()
