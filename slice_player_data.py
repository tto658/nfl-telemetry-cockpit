import os
import re
import time
import polars as pl

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Roots to slice into
ROOTS = [
    os.path.join(BASE_DIR, "tracking_by_position"),
    os.path.join(BASE_DIR, "combine_tracking_by_position"),
]

# 1. Load players for nfl_id -> nfl_position
players_df = pl.read_parquet(os.path.join(BASE_DIR, "players.parquet"))
id_to_pos = dict(zip(players_df["nfl_id"].to_list(), players_df["nfl_position"].to_list()))
print(f"Loaded {len(id_to_pos)} players from players.parquet")

# 2. Discover existing folder paths and prefixes for each root
# Map: (root, nfl_id) -> (folder_path, prefix)
folder_registry = {}

for root in ROOTS:
    if not os.path.exists(root):
        print(f"Warning: Root {root} does not exist, skipping.")
        continue
    matched = 0
    for pos in os.listdir(root):
        pos_dir = os.path.join(root, pos)
        if not os.path.isdir(pos_dir):
            continue
        for pf in os.listdir(pos_dir):
            p_dir = os.path.join(pos_dir, pf)
            if not os.path.isdir(p_dir):
                continue
            m = re.search(r'(?:^|_|\D)(\d{5})(?:_|\D|$)', pf)
            if m:
                nid = int(m.group(1))
                # Detect existing prefix from files inside
                files = os.listdir(p_dir)
                prefix = ""
                for f in files:
                    if "combine_tracking" in f:
                        prefix = f.replace("combine_tracking.parquet", "")
                        break
                folder_registry[(root, nid)] = (p_dir, prefix)
                matched += 1
    print(f"Root '{os.path.basename(root)}': matched {matched} player folders.")

# Also handle any missing nfl_ids by creating default folder if needed
for root in ROOTS:
    for nid, pos in id_to_pos.items():
        if (root, nid) not in folder_registry:
            pos_folder = pos if pos else "unknown_position"
            p_dir = os.path.join(root, pos_folder, str(nid))
            os.makedirs(p_dir, exist_ok=True)
            folder_registry[(root, nid)] = (p_dir, "")
            print(f"Created fallback folder for nfl_id {nid} at {p_dir}")

# 3. Slice combine_results.parquet
cr_path = os.path.join(BASE_DIR, "combine_results.parquet")
if os.path.exists(cr_path):
    print(f"\nProcessing {cr_path}...")
    t0 = time.time()
    cr_df = pl.read_parquet(cr_path)
    print(f"  Loaded {len(cr_df)} rows, {cr_df['nfl_id'].n_unique()} unique subjects")
    
    count_written = 0
    # Group by nfl_id and write to each root
    for sub_df in cr_df.partition_by("nfl_id", as_dict=False):
        nid = sub_df["nfl_id"][0]
        for root in ROOTS:
            info = folder_registry.get((root, nid))
            if not info:
                continue
            p_dir, prefix = info
            
            # Write with prefix if prefix exists
            if prefix:
                sub_df.write_parquet(os.path.join(p_dir, f"{prefix}combine_results.parquet"))
            # Always also write canonical combine_results.parquet
            sub_df.write_parquet(os.path.join(p_dir, "combine_results.parquet"))
            count_written += 1
            
    print(f"  Finished combine_results in {time.time()-t0:.2f}s ({count_written} files written)")
else:
    print(f"Warning: {cr_path} not found!")

# 4. Slice player_career_successes.parquet
pcs_path = os.path.join(BASE_DIR, "player_career_successes.parquet")
if os.path.exists(pcs_path):
    print(f"\nProcessing {pcs_path}...")
    t0 = time.time()
    pcs_df = pl.read_parquet(pcs_path)
    print(f"  Loaded {len(pcs_df)} rows, {pcs_df['nfl_id'].n_unique()} unique subjects")
    
    count_written = 0
    for sub_df in pcs_df.partition_by("nfl_id", as_dict=False):
        nid = sub_df["nfl_id"][0]
        for root in ROOTS:
            info = folder_registry.get((root, nid))
            if not info:
                continue
            p_dir, prefix = info
            
            # Write prefixed versions if prefix exists
            if prefix:
                sub_df.write_parquet(os.path.join(p_dir, f"{prefix}player_career_successes.parquet"))
                sub_df.write_parquet(os.path.join(p_dir, f"{prefix}player_career_success.parquet"))
            # Canonical versions (both plural 'successes' and singular 'success' for seamless compatibility)
            sub_df.write_parquet(os.path.join(p_dir, "player_career_successes.parquet"))
            sub_df.write_parquet(os.path.join(p_dir, "player_career_success.parquet"))
            count_written += 1
            
    print(f"  Finished player_career_successes in {time.time()-t0:.2f}s ({count_written} files written)")
else:
    print(f"Warning: {pcs_path} not found!")

# 5. Slice player_play.parquet
pp_path = os.path.join(BASE_DIR, "player_play.parquet")
if os.path.exists(pp_path):
    print(f"\nProcessing {pp_path}...")
    t0 = time.time()
    pp_df = pl.read_parquet(pp_path)
    print(f"  Loaded {len(pp_df):,} rows, {pp_df['nfl_id'].n_unique()} unique subjects")
    
    count_written = 0
    for sub_df in pp_df.partition_by("nfl_id", as_dict=False):
        nid = sub_df["nfl_id"][0]
        for root in ROOTS:
            info = folder_registry.get((root, nid))
            if not info:
                continue
            p_dir, prefix = info
            
            if prefix:
                sub_df.write_parquet(os.path.join(p_dir, f"{prefix}player_play.parquet"))
            sub_df.write_parquet(os.path.join(p_dir, "player_play.parquet"))
            count_written += 1
            
    print(f"  Finished player_play in {time.time()-t0:.2f}s ({count_written} files written)")
else:
    print(f"Warning: {pp_path} not found!")

print("\nAll slicing completed successfully.")
