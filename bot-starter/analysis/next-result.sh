#!/usr/bin/env bash
# Wait for the next logged A/B match to finish, record its result in
# ab-results.tsv, print it with the running per-version tally, then exit.
# Usage: bash analysis/next-result.sh
BOT=202
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$DIR/ab-log.tsv"; RES="$DIR/ab-results.tsv"
CLI="$LOCALAPPDATA/SpacetimeDB/bin/2.14.1/spacetimedb-cli.exe"
q(){ "$CLI" sql -s maincloud scrabblebot "$1" 2>/dev/null | grep -v UNSTABLE; }
touch "$RES"
record() {  # $1 match, $2 version
  local M=$1 V=$2 S ours place best coins won words
  S=$(q "SELECT bot_id, balance, score FROM match_participant WHERE match_id = $M" | grep -E '^ *[0-9]')
  ours=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0==b {print $3+0}')
  coins=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0==b {print $2+0}')
  [ -z "$ours" ] && return 1
  place=$(echo "$S" | awk -F'|' -v s="$ours" -v b=$BOT '$1+0!=b && $3+0 > s {n++} END {print n+1}')
  best=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0!=b {if ($3+0>m) m=$3+0} END {print m+0}')
  won=$("$CLI" sql -s maincloud scrabblebot "SELECT winner_bot_id FROM auction_result WHERE match_id = $M" 2>/dev/null | grep -c "some = $BOT")
  words=$(q "SELECT word, total_reward FROM word_play WHERE match_id = $M AND bot_id = $BOT" | grep -E '^ *"' | awk -F'|' '{gsub(/[ "]/,"",$1); gsub(/ /,"",$2); printf "%s(%s) ", $1, $2}')
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$M" "$V" "$place" "$ours" "$best" "$coins" "$won" "$words" >> "$RES"
}
# Catch up on any finished matches not yet recorded; then wait for the next one.
NEW=""
for i in $(seq 1 120); do
  while IFS=$'\t' read -r M V T; do
    [ -z "$M" ] && continue
    case "$V" in X*) continue;; esac
    grep -q "^$M	" "$RES" && continue
    if q "SELECT status FROM match_state WHERE id = $M" | grep -q ended; then
      record "$M" "$V" && NEW="$NEW $M"
    fi
  done < "$LOG"
  [ -n "$NEW" ] && break
  sleep 5
done
for M in $NEW; do
  awk -F'\t' -v m="$M" '$1==m {printf "NEW RESULT  match %s | version %s | place %s of 6 | score %s (best other %s) | coins left %s | tiles %s | %s\n", $1,$2,$3,$4,$5,$6,$7,$8}' "$RES"
done
echo "=== running tally ==="
awk -F'\t' '{n[$2]++; p[$2]+=$3; s[$2]+=$4; if ($3==1) w[$2]++} END {for (v in n) printf "version %-3s %2d matches | avg place %.2f | wins %d | avg score %.1f\n", v, n[v], p[v]/n[v], w[v], s[v]/n[v]}' "$RES" | sort
