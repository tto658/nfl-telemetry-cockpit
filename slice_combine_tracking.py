# Slice combine_tracking.parquet by nfl_id into position group folders
import os

import pandas as pd

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
OUTPUT_ROOT = os.path.join(BASE_DIR, "combine_tracking_by_position")
os.makedirs(OUTPUT_ROOT, exist_ok=True)

# Load players to get nfl_id -> nfl_position mapping
players = pd.read_parquet(os.path.join(BASE_DIR, "players.parquet"), engine="pyarrow")
id_to_pos = players.set_index("nfl_id")["nfl_position"].to_dict()

# Get all unique positions and create a folder for each
all_positions = {v for v in id_to_pos.values() if pd.notna(v)}
for pos in all_positions:
    os.makedirs(os.path.join(OUTPUT_ROOT, pos), exist_ok=True)
os.makedirs(os.path.join(OUTPUT_ROOT, "unknown_position"), exist_ok=True)
print(f"Created {len(all_positions)} position folders: {sorted(all_positions)}")

# Load combine_tracking
ct = pd.read_parquet(
    os.path.join(BASE_DIR, "combine_tracking.parquet"), engine="pyarrow"
)
print(
    f"combine_tracking.parquet: {len(ct)} rows, {ct['nfl_id'].nunique()} unique nfl_ids"
)

# Slice by nfl_id and write into position/nfl_id folders
for nfl_id, group in ct.groupby("nfl_id"):
    pos = id_to_pos.get(nfl_id)
    pos_folder = pos if pd.notna(pos) else "unknown_position"
    id_folder = os.path.join(OUTPUT_ROOT, pos_folder, str(nfl_id))
    os.makedirs(id_folder, exist_ok=True)
    group.to_parquet(
        os.path.join(id_folder, "combine_tracking.parquet"), engine="pyarrow"
    )

print("Done. All slices written.")
