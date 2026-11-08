#!/usr/bin/env bash
# Per-version results of the live A/B test (reads ab-log.tsv written by the bot).
# Usage: bash analysis/ab-report.sh
BOT=202
CLI="$LOCALAPPDATA/SpacetimeDB/bin/2.14.1/spacetimedb-cli.exe"
q(){ "$CLI" sql -s maincloud scrabblebot "$1" 2>/dev/null | grep -v UNSTABLE; }
LOG="$(dirname "$0")/../ab-log.tsv"
[ -f "$LOG" ] || { echo "no ab-log.tsv yet"; exit 0; }
OUT=""
while IFS=$'\t' read -r M V T; do
  [ -z "$M" ] && continue
  q "SELECT status FROM match_state WHERE id = $M" | grep -q ended || { echo "match $M ($V): still running"; continue; }
  S=$(q "SELECT bot_id, score FROM match_participant WHERE match_id = $M" | grep -E '^ *[0-9]')
  ours=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0==b {print $2+0}')
  [ -z "$ours" ] && continue
  place=$(echo "$S" | awk -F'|' -v s="$ours" -v b=$BOT '$1+0!=b && $2+0 > s {n++} END {print n+1}')
  best=$(echo "$S" | awk -F'|' -v b=$BOT '$1+0!=b {if ($2+0>m) m=$2+0} END {print m+0}')
  echo "match $M | version $V | place $place | score $ours | best other $best"
  OUT+="$V $place $ours"$'\n'
done < "$LOG"
echo "=== by version ==="
echo -n "$OUT" | awk 'NF==3 {n[$1]++; p[$1]+=$2; s[$1]+=$3; if ($2==1) w[$1]++} END {for (v in n) printf "version %s: %d matches | avg place %.2f | wins %d | avg score %.1f\n", v, n[v], p[v]/n[v], w[v], s[v]/n[v]}'
