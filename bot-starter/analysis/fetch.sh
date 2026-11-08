#!/usr/bin/env bash
# Download recent public match data for top5.py.
# Usage: bash analysis/fetch.sh <first match id> <output dir>
# Then:  python analysis/top5.py <output dir>
LO=${1:-42400}; D=${2:-./match-data}; mkdir -p "$D"
CLI="$LOCALAPPDATA/SpacetimeDB/bin/2.14.1/spacetimedb-cli.exe"
q(){ "$CLI" sql -s maincloud scrabblebot "$1" 2>/dev/null; }
q "SELECT match_id, auction_id, letter, winner_bot_id, paid, closed_at FROM auction_result WHERE match_id >= $LO" > "$D/t_auc.txt" &
q "SELECT auction_id, match_id, top_bid FROM auction_top_bid_archive WHERE match_id >= $LO" > "$D/t_top.txt" &
q "SELECT match_id, bot_id, word, total_reward, played_at FROM word_play WHERE match_id >= $LO" > "$D/t_words.txt" &
q "SELECT match_id, bot_id, balance, score FROM match_participant WHERE match_id >= $LO" > "$D/t_parts.txt" &
q "SELECT id, status, auction_type, created_at FROM match_state WHERE id >= $LO" > "$D/t_matches.txt" &
wait; wc -l "$D"/t_*.txt
