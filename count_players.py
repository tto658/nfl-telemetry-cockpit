#!/usr/bin/env python3
"""
Counts how many unique players (nfl_id) that appear in the original player_play.csv
are also present in players.csv.
Uses out-of-core streaming via polars (or duckdb) for speed and memory efficiency.
"""

from pathlib import Path
import polars as pl

def main():
    base_dir = Path(__file__).resolve().parent

    player_play_path = base_dir / "player_play.csv"
    players_path = base_dir / "players.csv"

    if not player_play_path.exists():
        # Fallback to data directory or subfolder if moved
        candidates = list(base_dir.rglob("player_play.csv"))
        if candidates:
            player_play_path = candidates[0]
        else:
            raise FileNotFoundError(f"Cannot find player_play.csv in {base_dir}")

    if not players_path.exists():
        candidates = list(base_dir.rglob("players.csv"))
        if candidates:
            players_path = candidates[0]
        else:
            raise FileNotFoundError(f"Cannot find players.csv in {base_dir}")

    print(f"Loading players from: {players_path}")
    print(f"Scanning player_play from: {player_play_path}")

    # Read unique nfl_id from players.csv
    players_df = pl.read_csv(players_path, columns=["nfl_id"])
    unique_players_in_players_csv = set(players_df["nfl_id"].drop_nulls().unique().to_list())
    total_players_csv = len(unique_players_in_players_csv)

    # Scan player_play.csv using lazy evaluation
    player_play_lazy = (
        pl.scan_csv(player_play_path)
        .select(["nfl_id"])
        .drop_nulls()
        .unique()
    )
    unique_pp_players = set(player_play_lazy.collect()["nfl_id"].to_list())
    total_pp_players = len(unique_pp_players)

    # Intersect
    in_both = unique_pp_players.intersection(unique_players_in_players_csv)
    pp_not_in_players = unique_pp_players - unique_players_in_players_csv
    players_not_in_pp = unique_players_in_players_csv - unique_pp_players

    print("\n" + "=" * 50)
    print(f"Unique players in players.csv:           {total_players_csv:,}")
    print(f"Unique players in player_play.csv:       {total_pp_players:,}")
    print(f"Players appearing in BOTH:               {len(in_both):,}")
    print(f"In player_play.csv but NOT players.csv:  {len(pp_not_in_players):,}")
    print(f"In players.csv but NOT player_play.csv:  {len(players_not_in_pp):,}")
    print("=" * 50)

    if players_not_in_pp:
        print(f"\nExample nfl_ids in players.csv with NO plays ({len(players_not_in_pp)} total):")
        print(list(players_not_in_pp)[:15])

if __name__ == "__main__":
    main()
