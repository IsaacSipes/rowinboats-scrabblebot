#!/usr/bin/env bash
# Record the next N full live matches of our bot (id 202) that start after
# match id AFTER, then print a summary table.
# Usage: bash analysis/record.sh <after match id> <N>
AFTER=${1:?after match id}; N=${2:-5}; BOT=202
CLI="$LOCALAPPDATA/SpacetimeDB/bin/2.14.1/spacetimedb-cli.exe"
q(){ "$CLI" sql -s maincloud scrabblebot "$1" 2>/dev/null | grep -v UNSTABLE; }
done_ids=()
last=$AFTER
summary=""
while [ ${#done_ids[@]} -lt "$N" ]; do
  # Our next match after $last.
  M=""
  for i in $(seq 1 120); do
    M=$(q "SELECT match_id FROM match_participant WHERE bot_id = $BOT" | grep -oE '^ *[0-9]+' | tr -d ' ' | sort -n | awk -v a="$last" '$1 > a' | head -1)
    [ -n "$M" ] && break
    sleep 10
  done
  [ -z "$M" ] && { echo "no new match found"; break; }
  for i in $(seq 1 120); do
    q "SELECT status FROM match_state WHERE id = $M" | grep -q ended && break
    sleep 10
  done
  scores=$(q "SELECT bot_id, balance, score FROM match_participant WHERE match_id = $M" | grep -E '^ *[0-9]')
  ours=$(echo "$scores" | awk -F'|' -v b=$BOT '$1+0==b {print $3+0" "$2+0}')
  our_score=${ours%% *}; our_coins=${ours##* }
  place=$(echo "$scores" | awk -F'|' -v s="$our_score" '$3+0 > s {n++} END {print n+1}')
  best=$(echo "$scores" | awk -F'|' '{if ($3+0 > m) m=$3+0} END {print m}')
  won=$("$CLI" sql -s maincloud scrabblebot "SELECT winner_bot_id FROM auction_result WHERE match_id = $M" 2>/dev/null | grep -c "some = $BOT")
  words=$(q "SELECT word, total_reward FROM word_play WHERE match_id = $M AND bot_id = $BOT" | grep -E '^ *"' | awk -F'|' '{gsub(/[ "]/,"",$1); gsub(/ /,"",$2); printf "%s(%s) ", $1, $2}')
  letters=$(echo "$words" | tr ' ' '\n' | sed 's/(.*//' | tr -d '\n' | wc -c)
  wasted=$(( 5 + won - letters ))
  line=$(printf "match %s | place %s of 6 | score %s (winner %s) | coins left %s | tiles won %s | tiles wasted %s | %s" "$M" "$place" "$our_score" "$best" "$our_coins" "$won" "$wasted" "$words")
  echo "$line"
  summary+="$line"$'\n'
  done_ids+=("$M")
  last=$M
done
echo "=== SUMMARY (${#done_ids[@]} matches) ==="
echo -n "$summary"
echo "$summary" | awk -F'|' 'NF>3 {split($2,a," "); split($3,b," "); split($4,c," "); split($6,d," "); p+=a[2]; s+=b[2]; co+=c[3]; w+=d[3]; n++; if (a[2]==1) wins++} END {if (n) printf "avg place %.2f | wins %d of %d | avg score %.1f | avg coins left %.1f | avg tiles wasted %.1f\n", p/n, wins, n, s/n, co/n, w/n}'
