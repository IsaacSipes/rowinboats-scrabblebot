#!/usr/bin/env bash
# Run several strategy variants on the SAME simulated games, in parallel,
# and print them sorted by average placement (lower is better).
#
# Usage: bash tune.sh <games> <room> <seed> "tag P_x=1 P_y=2" "tag2 P_z=3" ...
# Example: bash tune.sh 150 tough 7 "base" "cheap P_volumeA=7"
#
# Runs at most 6 at once and drops them to low CPU priority, so a live bot on
# the same PC keeps bidding on time (8 full-speed sims starved it once).
set -u
GAMES=$1; ROOM=$2; SEED=$3; shift 3
NODE_DIR=$(ls -d "$LOCALAPPDATA"/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS*/node-*/ 2>/dev/null | head -1)
[ -n "$NODE_DIR" ] && export PATH="$PATH:$NODE_DIR"
OUT=$(mktemp -d)
MAXJOBS=3
lower_priority() {
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { \$_.CommandLine -match 'sim\\.ts' } | ForEach-Object { try { (Get-Process -Id \$_.ProcessId).PriorityClass = 'Idle' } catch {} }" >/dev/null 2>&1
}
i=0
for spec in "$@"; do
  while [ "$(jobs -rp | wc -l)" -ge "$MAXJOBS" ]; do sleep 2; done
  read -r tag envs <<< "$spec"
  ( env $envs npx tsx src/sim.ts "$GAMES" "$ROOM" "$SEED" "$tag" > "$OUT/$i.txt" 2>&1 ) &
  i=$((i + 1))
  sleep 3; lower_priority
done
# Keep re-applying low priority while jobs run (new node children appear).
while [ "$(jobs -rp | wc -l)" -gt 0 ]; do lower_priority; sleep 20; done
wait
cat "$OUT"/*.txt | sort -t' ' -k3 -n
rm -rf "$OUT"
