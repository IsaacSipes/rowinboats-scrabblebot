#!/usr/bin/env bash
# Wait for the next A/B event — a match STARTING (new line in ab-log.tsv) or a
# logged match ENDING — print it, then exit. Results go to ab-results.tsv.
# Usage: bash analysis/next-event.sh
BOT=202
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$DIR/ab-log.tsv"; RES="$DIR/ab-results.tsv"; ANN="$DIR/.announced"
CLI="$LOCALAPPDATA/SpacetimeDB/bin/2.14.1/spacetimedb-cli.exe"
q(){ "$CLI" sql -s maincloud scrabblebot "$1" 2>/dev/null | grep -v UNSTABLE; }
touch "$RES" "$ANN"
# Matches already finished before this watcher existed count as announced.
cut -f1 "$RES" >> "$ANN"
record() {
  local M=$1 V=$2 S ours place best coins won words
  grep -q "^$M	" "$RES" && return 1
  S=$(q "SELECT bot_id, balance, score FROM match_participant WHERE match_id = $M" | grep -E '^ *[0-9]')
  ours=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0==b {print $3+0}')
  coins=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0==b {print $2+0}')
  [ -z "$ours" ] && return 1
  place=$(echo "$S" | awk -F'|' -v s="$ours" -v b=$BOT '$1+0!=b && $3+0 > s {n++} END {print n+1}')
  best=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0!=b {if ($3+0>m) m=$3+0} END {print m+0}')
  won=$("$CLI" sql -s maincloud scrabblebot "SELECT winner_bot_id FROM auction_result WHERE match_id = $M" 2>/dev/null | grep -c "some = $BOT")
  words=$(q "SELECT word, total_reward FROM word_play WHERE match_id = $M AND bot_id = $BOT" | grep -E '^ *"' | awk -F'|' '{gsub(/[ "]/,"",$1); gsub(/ /,"",$2); printf "%s(%s) ", $1, $2}')
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$M" "$V" "$place" "$ours" "$best" "$coins" "$won" "$words" >> "$RES"
  printf "ENDED  match %s | version %s | place %s of 6 | score %s (best other %s) | coins left %s | tiles %s | %s\n" "$M" "$V" "$place" "$ours" "$best" "$coins" "$won" "$words"
}
for i in $(seq 1 400); do
  while IFS=$'\t' read -r M V T; do
    [ -z "$M" ] && continue
    case "$V" in X*) continue;; esac
    if ! grep -qx "$M" "$ANN"; then
      echo "$M" >> "$ANN"
      echo "STARTED  match $M | version $V | watch: https://scrabblebot.spacetimedb.com/matches/$M"
      exit 0
    fi
    if ! grep -q "^$M	" "$RES" && q "SELECT status FROM match_state WHERE id = $M" | grep -q ended; then
      record "$M" "$V"
      echo "=== running tally ==="
      awk -F'\t' '{n[$2]++; p[$2]+=$3; s[$2]+=$4; if ($3==1) w[$2]++} END {for (v in n) printf "version %-3s %2d matches | avg place %.2f | wins %d | avg score %.1f\n", v, n[v], p[v]/n[v], w[v], s[v]/n[v]}' "$RES" | sort
      exit 0
    fi
  done < "$LOG"
  sleep 2
done
