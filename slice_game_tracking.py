# Slice game_tracking Parquet files by nfl_id into position group folders
# Uses the same structure as combine_tracking_by_position
import os

import pandas as pd

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
OUTPUT_ROOT = os.path.join(BASE_DIR, "combine_tracking_by_position")
os.makedirs(OUTPUT_ROOT, exist_ok=True)

# Load players to get nfl_id -> nfl_position mapping
players = pd.read_parquet(os.path.join(BASE_DIR, "players.parquet"), engine="pyarrow")
id_to_pos = players.set_index("nfl_id")["nfl_position"].to_dict()

# Ensure all position folders exist
all_positions = {v for v in id_to_pos.values() if pd.notna(v)}
for pos in all_positions:
    os.makedirs(os.path.join(OUTPUT_ROOT, pos), exist_ok=True)
os.makedirs(os.path.join(OUTPUT_ROOT, "unknown_position"), exist_ok=True)

# Process each game_tracking file
tracking_files = [
    "game_tracking_2023.parquet",
    "game_tracking_2024.parquet",
    "game_tracking_2025.parquet",
]

for fname in tracking_files:
    src = os.path.join(BASE_DIR, fname)
    if not os.path.exists(src):
        print(f"Skipping {fname}: file not found.")
        continue
    print(f"Processing {fname}...")
    df = pd.read_parquet(src, engine="pyarrow")
    print(f"  {len(df)} rows, {df['nfl_id'].nunique()} unique nfl_ids")
    for nfl_id, group in df.groupby("nfl_id"):
        pos = id_to_pos.get(nfl_id)
        pos_folder = pos if pd.notna(pos) else "unknown_position"
        id_folder = os.path.join(OUTPUT_ROOT, pos_folder, str(nfl_id))
        os.makedirs(id_folder, exist_ok=True)
        group.to_parquet(os.path.join(id_folder, fname), engine="pyarrow")
    print(f"  Finished {fname}")

print("Done. All game_tracking slices written.")
