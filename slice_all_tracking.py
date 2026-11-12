# Slice combine_tracking + game_tracking files by nfl_id
# Create folders named: nfl_id_display_name_draft_year (no rename needed)
import os

import pandas as pd

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
OUTPUT_ROOT = os.path.join(BASE_DIR, "tracking_by_position")
os.makedirs(OUTPUT_ROOT, exist_ok=True)

# Load players for nfl_id -> (position, display_name, draft_year)
players = pd.read_parquet(os.path.join(BASE_DIR, "players.parquet"), engine="pyarrow")


def safe_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in " -_" else "_" for c in str(s)).replace(
        " ", "_"
    )


player_info = {}
for _, row in players.iterrows():
    nfl_id = row["nfl_id"]
    pos = row["nfl_position"] if pd.notna(row["nfl_position"]) else "unknown_position"
    name = (
        safe_name(row["display_name"]) if pd.notna(row["display_name"]) else "Unknown"
    )
    year = str(int(row["draft_year"])) if pd.notna(row["draft_year"]) else "UDFA"
    folder_name = f"{nfl_id}_{name}_{year}"
    player_info[nfl_id] = (pos, folder_name)

# Create all position folders upfront
all_positions = {v[0] for v in player_info.values()}
for pos in all_positions:
    os.makedirs(os.path.join(OUTPUT_ROOT, pos), exist_ok=True)
os.makedirs(os.path.join(OUTPUT_ROOT, "unknown_position"), exist_ok=True)
print(f"Created {len(all_positions)} position folders: {sorted(all_positions)}")

# Files to slice
files_to_slice = [
    "combine_tracking.parquet",
    "game_tracking_2023.parquet",
    "game_tracking_2024.parquet",
    "game_tracking_2025.parquet",
]

for fname in files_to_slice:
    src = os.path.join(BASE_DIR, fname)
    if not os.path.exists(src):
        print(f"Skipping {fname}: not found.")
        continue
    print(f"Processing {fname}...")
    df = pd.read_parquet(src, engine="pyarrow")
    print(f"  {len(df):,} rows, {df['nfl_id'].nunique()} unique nfl_ids")
    for nfl_id, group in df.groupby("nfl_id"):
        info = player_info.get(nfl_id)
        if info:
            pos, folder_name = info
        else:
            pos = "unknown_position"
            folder_name = str(nfl_id)
        out_dir = os.path.join(OUTPUT_ROOT, pos, folder_name)
        os.makedirs(out_dir, exist_ok=True)
        group.to_parquet(os.path.join(out_dir, fname), engine="pyarrow")
    print(f"  Finished {fname}")

print("Done. All tracking files sliced into tracking_by_position/.")
