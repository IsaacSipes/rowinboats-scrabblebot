"""What do the CURRENT leaders do, aspect by aspect? (bids vs coins / phase /
rack need, spending, words, endgame). Usage: python analysis/pattern.py <dir>"""
import sys, re, collections, statistics as st
from datetime import datetime

D = sys.argv[1]
US = "202"
VAL = dict(A=1,B=3,C=3,D=2,E=1,F=4,G=2,H=4,I=1,J=8,K=5,L=1,M=3,N=1,O=1,P=3,Q=10,R=1,S=1,T=1,U=1,V=4,W=4,X=8,Y=4,Z=10)
VOW = set("AEIOU")

def rows(f):
    out = []
    for line in open(f"{D}/{f}", encoding="utf-8", errors="replace"):
        p = [x.strip() for x in line.split("|")]
        if len(p) >= 3 and p[0].isdigit():
            out.append([x.strip('"') for x in p])
    return out
def ts(s):
    s = s.replace("+00:00", ""); a, _, b = s.partition(".")
    return datetime.strptime(a, "%Y-%m-%dT%H:%M:%S").timestamp() + (float("0." + b) if b else 0)
def opt(s):
    m = re.search(r"some = (\d+)", s); return m.group(1) if m else None

names = {r[0]: r[1] for r in rows("bots.txt")}
sim = {r[0] for r in rows("bots.txt") if r[2] == "true"}
ended = {r[0] for r in rows("t_matches.txt") if "ended" in r[1] and "vickrey" in r[2]}
top = {a: int(t) for a, m, t in rows("t_top.txt")}
auc = collections.defaultdict(list)
for mid, aid, L, win, paid, closed in rows("t_auc.txt"):
    if mid in ended:
        auc[mid].append(dict(aid=int(aid), L=L, win=opt(win), paid=int(paid), t=ts(closed), top=top.get(aid)))
words = collections.defaultdict(list)
for mid, bot, word, rew, played in rows("t_words.txt"):
    if mid in auc:
        words[mid].append(dict(bot=bot, w=word, rew=int(rew), t=ts(played)))
parts = collections.defaultdict(dict)
for mid, bot, bal, score in rows("t_parts.txt"):
    if mid in auc:
        parts[mid][bot] = (int(bal), int(score))
for mid, lst in auc.items():
    lst.sort(key=lambda a: a["aid"])
    for i, a in enumerate(lst):
        a["rd"] = i
    for w in words[mid]:
        w["rd"] = sum(1 for a in lst if a["t"] <= w["t"])
def place(m, b):
    s = parts[m][b][1]; return 1 + sum(1 for x, (_, y) in parts[m].items() if x != b and y > s)
def line(v):  # the common market line
    return 11 + 3 * v

stats = collections.defaultdict(list)
for m in parts:
    if len(parts[m]) == 6:
        for b in parts[m]:
            if b not in sim:
                stats[b].append(m)
ranked = sorted(((st.mean(place(m, b) for m in ms), b) for b, ms in stats.items() if len(ms) >= 12))
leaders = [b for p, b in ranked if b != US][:8]
show = leaders + ([US] if US in stats else [])
print(f"{len(auc)} matches since ~7:00 PM. Current leaders by average placement (12+ matches):")
for p, b in ranked[:10]:
    print(f"  {names.get(b, b)[:20]:20s} place {p:.2f}  win {100*st.mean(1 if place(m,b)==1 else 0 for m in stats[b]):3.0f}%  score {st.mean(parts[m][b][1] for m in stats[b]):5.1f}  n={len(stats[b])}")
if US in stats:
    print(f"  {'(us) Rowin' + chr(39) + 'Boats':20s} place {st.mean(place(m,US) for m in stats[US]):.2f}  n={len(stats[US])}")

def analyze(b):
    R = collections.defaultdict(list)
    for m in stats[b]:
        lst = auc[m]; n = len(lst)
        ev = [(a["t"], 0, a) for a in lst] + [(w["t"], 1, w) for w in words[m] if w["bot"] == b]
        ev.sort(key=lambda e: (e[0], e[1]))
        bal = 100; held = collections.Counter(); wonlog = []
        for _, kind, x in ev:
            if kind == 0:
                if x["win"] == b:
                    if x["top"] is not None:
                        ratio = x["top"] / line(VAL[x["L"]])
                        ph = 0 if x["rd"] < 23 else (1 if x["rd"] < 46 else 2)
                        R["ratio_phase%d" % ph].append(ratio)
                        bb = 0 if bal < 25 else (1 if bal < 50 else (2 if bal < 75 else 3))
                        R["ratio_bal%d" % bb].append(ratio)
                        R["ratio_dup" if held[x["L"]] > 0 else "ratio_fresh"].append(ratio)
                        wonlog.append((x["rd"], x["L"], ratio))
                    bal -= x["paid"]; held[x["L"]] += 1
                    R["tiles_ph%d" % (0 if x["rd"] < 23 else (1 if x["rd"] < 46 else 2))].append(1)
            else:
                bal += x["rew"]
                for c in x["w"]:
                    if held[c] > 0:
                        held[c] -= 1
                R["word_len"].append(len(x["w"])); R["word_rd"].append(x["rd"]); R["word_rew"].append(x["rew"])
                R["word_left"].append(n - x["rd"])
        # quick-use: was a won tile played within 12 rounds? (match tiles FIFO by letter)
        q = collections.defaultdict(list)
        for rd, L, ratio in wonlog:
            q[L].append([rd, ratio, None])
        for w in sorted((w for w in words[m] if w["bot"] == b), key=lambda w: w["t"]):
            for c in w["w"]:
                for item in q[c]:
                    if item[2] is None and item[0] <= w["rd"]:
                        item[2] = w["rd"]; break
        for L, items in q.items():
            for rd, ratio, used in items:
                if used is None:
                    R["ratio_unused"].append(ratio)
                elif used - rd <= 12:
                    R["ratio_quick"].append(ratio); R["hold"].append(used - rd)
                else:
                    R["ratio_slow"].append(ratio); R["hold"].append(used - rd)
        R["coins_end"].append(parts[m][b][0])
    return R

def mean(x):
    return st.mean(x) if x else float("nan")
print("\nBid level = winning bid ÷ market line (11 + 3 × letter value); 1.00 = on the line")
print(f"{'bot':20} {'early':>6} {'mid':>6} {'late':>6} | {'coins<25':>8} {'25-49':>6} {'50-74':>6} {'75+':>6} | {'fresh':>6} {'dup':>6} | {'quick':>6} {'slow':>6} {'unused':>6}")
data = {}
for b in show:
    R = analyze(b); data[b] = R
    print(f"{names.get(b,b)[:20]:20} {mean(R['ratio_phase0']):6.2f} {mean(R['ratio_phase1']):6.2f} {mean(R['ratio_phase2']):6.2f} | "
          f"{mean(R['ratio_bal0']):8.2f} {mean(R['ratio_bal1']):6.2f} {mean(R['ratio_bal2']):6.2f} {mean(R['ratio_bal3']):6.2f} | "
          f"{mean(R['ratio_fresh']):6.2f} {mean(R['ratio_dup']):6.2f} | {mean(R['ratio_quick']):6.2f} {mean(R['ratio_slow']):6.2f} {mean(R['ratio_unused']):6.2f}")
print("\nTiles and words")
print(f"{'bot':20} {'tiles e/m/l':>15} {'words':>5} {'avg len':>7} {'pts/word':>8} {'1st word rd':>11} {'hold rds':>8} {'words in last 5':>15} {'coins end':>9}")
for b in show:
    R = data[b]; n = len(stats[b])
    first = []
    for m in stats[b]:
        rds = [w["rd"] for w in words[m] if w["bot"] == b]
        first.append(min(rds) if rds else 68)
    print(f"{names.get(b,b)[:20]:20} {len(R['tiles_ph0'])/n:4.1f}/{len(R['tiles_ph1'])/n:4.1f}/{len(R['tiles_ph2'])/n:4.1f} {len(R['word_len'])/n:5.1f} "
          f"{mean(R['word_len']):7.1f} {mean(R['word_rew']):8.1f} {mean(first):11.1f} {mean(R['hold']):8.1f} {sum(1 for x in R['word_left'] if x <= 5)/n:15.2f} {mean(R['coins_end']):9.1f}")
