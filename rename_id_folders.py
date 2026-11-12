# Rename nfl_id folders to nfl_id + display_name + draft_year (with retry for locks)
import os
import time

import pandas as pd

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
OUTPUT_ROOT = os.path.join(BASE_DIR, "combine_tracking_by_position")

# Load players for display_name and draft_year
players = pd.read_parquet(os.path.join(BASE_DIR, "players.parquet"), engine="pyarrow")
player_info = {}
for _, row in players.iterrows():
    nfl_id = str(row["nfl_id"])
    name = (
        str(row["display_name"]).strip() if pd.notna(row["display_name"]) else "Unknown"
    )
    year = str(int(row["draft_year"])) if pd.notna(row["draft_year"]) else "UDFA"
    safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in name).replace(
        " ", "_"
    )
    player_info[nfl_id] = f"{nfl_id}_{safe_name}_{year}"

renamed = 0
skipped = 0
failed = 0

for pos_folder in os.listdir(OUTPUT_ROOT):
    pos_path = os.path.join(OUTPUT_ROOT, pos_folder)
    if not os.path.isdir(pos_path):
        continue
    for id_folder in os.listdir(pos_path):
        id_path = os.path.join(pos_path, id_folder)
        if not os.path.isdir(id_path):
            continue
        new_name = player_info.get(id_folder)
        if new_name and new_name != id_folder:
            new_path = os.path.join(pos_path, new_name)
            if os.path.exists(new_path):
                skipped += 1
                continue
            success = False
            for attempt in range(5):
                try:
                    os.rename(id_path, new_path)
                    success = True
                    break
                except PermissionError:
                    time.sleep(0.5)
            if success:
                renamed += 1
            else:
                print(f"  FAILED after retries: {id_path}")
                failed += 1
        else:
            skipped += 1

print(f"Renamed {renamed} folders, skipped {skipped}, failed {failed}.")
