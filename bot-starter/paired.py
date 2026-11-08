"""Game-by-game comparison of simulator variants that played the same games.

Usage: python paired.py <room> <seed> <games> <baseline tag>
Prints, for every other variant, its average placement change vs the
baseline on the same games (negative = better) with a standard error.
"""
import json, glob, os, sys, math

room, seed, games, base = sys.argv[1:5]
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sim-ranks")
prefix = f"{room}-{seed}-{games}-"
runs = {}
for f in glob.glob(os.path.join(d, prefix + "*.json")):
    runs[os.path.basename(f)[len(prefix):-5]] = json.load(open(f))
b = runs[base]
rows = []
for tag, r in runs.items():
    if tag == base:
        continue
    diffs = [x - y for x, y in zip(r, b)]
    n = len(diffs)
    m = sum(diffs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in diffs) / max(1, n - 1))
    se = sd / math.sqrt(n)
    rows.append((m, se, tag, sum(r) / n))
rows.sort()
print(f"baseline {base}: avg placement {sum(b)/len(b):.2f}")
for m, se, tag, avg in rows:
    flag = "BETTER" if m + 2 * se < 0 else ("worse" if m - 2 * se > 0 else "")
    print(f"  {tag:28s} placement {avg:.2f}  change {m:+.3f} ±{se:.3f}  {flag}")
