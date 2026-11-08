"""Deep comparison of the leading bots vs ours, from public match data.

Usage: python analysis/leaders.py <data dir from fetch.sh (+ bots.txt)> [our first match id]
"""
import sys, re, collections, statistics as st
from datetime import datetime

D = sys.argv[1]
OUR_FROM = int(sys.argv[2]) if len(sys.argv) > 2 else 43327
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
    s = s.replace("+00:00", "")
    a, _, b = s.partition(".")
    return datetime.strptime(a, "%Y-%m-%dT%H:%M:%S").timestamp() + (float("0." + b) if b else 0)

def opt(s):
    m = re.search(r"some = (\d+)", s)
    return m.group(1) if m else None

names = {r[0]: r[1] for r in rows("bots.txt")}
sim = {r[0] for r in rows("bots.txt") if r[2] == "true"}
ended = {r[0] for r in rows("t_matches.txt") if "ended" in r[1]}
vick = {r[0] for r in rows("t_matches.txt") if "vickrey" in r[2]}
top = {a: int(t) for a, m, t in rows("t_top.txt")}
auc = collections.defaultdict(list)
for mid, aid, letter, win, paid, closed in rows("t_auc.txt"):
    if mid in ended and mid in vick:
        auc[mid].append(dict(aid=int(aid), L=letter, win=opt(win), paid=int(paid), t=ts(closed), top=top.get(aid)))
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
        a["r"] = i
    n = len(lst)
    for w in words[mid]:
        w["rd"] = sum(1 for a in lst if a["t"] <= w["t"])  # auctions closed before the play
        w["left"] = n - w["rd"]

def place(mid, bot):
    s = parts[mid][bot][1]
    return 1 + sum(1 for b, (_, x) in parts[mid].items() if b != bot and x > s)

def phase(r):
    return 0 if r < 23 else (1 if r < 46 else 2)

# ---------- bot selection ----------
stats = {}
for mid in parts:
    if len(parts[mid]) < 6:
        continue
    for b in parts[mid]:
        if b in sim:
            continue
        if b == US and int(mid) < OUR_FROM:
            continue
        stats.setdefault(b, []).append(mid)
cands = [(st.mean(place(m, b) for m in ms), b) for b, ms in stats.items() if len(ms) >= 25 or b == US]
cands.sort()
leaders = [b for _, b in cands if b != US][:6]
show = leaders + [US]

def label(b):
    return ("US " if b == US else "") + names.get(b, b)[:14]

# ---------- per-bot profile ----------
prof = {}
for b in show:
    ms = stats[b]
    P = dict(n=len(ms))
    P["place"] = st.mean(place(m, b) for m in ms)
    P["win"] = st.mean(1 if place(m, b) == 1 else 0 for m in ms)
    P["score"] = st.mean(parts[m][b][1] for m in ms)
    P["coins_end"] = st.mean(parts[m][b][0] for m in ms)
    won = [a for m in ms for a in auc[m] if a["win"] == b]
    P["tiles"] = len(won) / len(ms)
    P["tiles_ph"] = [sum(1 for a in won if phase(a["r"]) == k) / len(ms) for k in range(3)]
    P["first3"] = sum(1 for a in won if a["r"] < 3) / len(ms)
    P["last5"] = sum(1 for a in won if a["r"] >= len(auc[a_m]) - 5 for a_m in [None]) if False else 0
    last5 = 0
    for m in ms:
        n = len(auc[m])
        last5 += sum(1 for a in auc[m] if a["win"] == b and a["r"] >= n - 5)
    P["last5"] = last5 / len(ms)
    P["paid"] = st.mean(a["paid"] for a in won) if won else 0
    bids = [(VAL[a["L"]], a["top"], phase(a["r"])) for a in won if a["top"] is not None]
    # least squares bid = a + b*face
    if len(bids) > 20:
        xs = [x for x, _, _ in bids]; ys = [y for _, y, _ in bids]
        mx, my = st.mean(xs), st.mean(ys)
        bb = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / max(1e-9, sum((x - mx) ** 2 for x in xs))
        P["fit"] = (my - bb * mx, bb)
        P["bid_ph"] = [st.mean(y for x, y, p in bids if p == k) if any(p == k for _, _, p in bids) else 0 for k in range(3)]
    else:
        P["fit"] = (0, 0); P["bid_ph"] = [0, 0, 0]
    # coin trajectory: balance at round marks, broke share
    marks = [0, 12, 23, 34, 46, 57, 67]
    traj = collections.defaultdict(list)
    broke = 0; seen = 0
    racks = []; held_at_play = []
    for m in ms:
        ev = [(a["t"], "a", a) for a in auc[m]] + [(w["t"], "w", w) for w in words[m] if w["bot"] == b]
        ev.sort(key=lambda e: e[0])
        bal = 100; held = 5; r = 0
        for _, kind, x in ev:
            if kind == "a":
                if x["r"] in marks:
                    traj[x["r"]].append(bal)
                seen += 1
                if bal < 10:
                    broke += 1
                if x["win"] == b:
                    bal -= x["paid"]; held += 1
            else:
                held_at_play.append(held)
                bal += x["rew"]; held -= len(x["w"])
        racks.append(held)
    P["traj"] = {k: st.mean(v) for k, v in sorted(traj.items())}
    P["broke"] = broke / max(1, seen)
    P["held_at_play"] = st.mean(held_at_play) if held_at_play else 0
    P["wasted"] = st.mean(racks)
    ws = [w for m in ms for w in words[m] if w["bot"] == b]
    P["words"] = len(ws) / len(ms)
    P["wlen"] = st.mean(len(w["w"]) for w in ws) if ws else 0
    P["wrew"] = st.mean(w["rew"] for w in ws) if ws else 0
    P["long_share"] = sum(w["rew"] for w in ws if len(w["w"]) >= 7) / max(1, sum(w["rew"] for w in ws))
    P["eight_plus"] = sum(1 for w in ws if len(w["w"]) >= 8) / len(ms)
    P["first_word_round"] = st.mean(min((w["rd"] for w in words[m] if w["bot"] == b), default=68) for m in ms)
    P["end_words"] = sum(1 for w in ws if w["left"] <= 5) / len(ms)
    P["end_pts"] = sum(w["rew"] for w in ws if w["left"] <= 5) / len(ms)
    P["vowel_share_won"] = sum(1 for a in won if a["L"] in VOW) / max(1, len(won))
    P["hi_share_won"] = sum(1 for a in won if VAL[a["L"]] >= 4) / max(1, len(won))
    prof[b] = P

print(f"Window: {len(auc)} Vickrey matches; ours from match {OUR_FROM} ({len(stats[US])} matches)\n")
print("== Outcomes (bots with 25+ matches, ranked by average placement) ==")
print(f"{'bot':18} {'n':>4} {'place':>6} {'win%':>5} {'score':>6} {'coinsEnd':>8}")
for b in show:
    P = prof[b]
    print(f"{label(b):18} {P['n']:4d} {P['place']:6.2f} {100*P['win']:5.0f} {P['score']:6.1f} {P['coins_end']:8.1f}")

print("\n== Tiles: how many, when, at what price ==")
print(f"{'bot':18} {'tiles':>5} {'early/mid/late':>15} {'first3':>6} {'last5':>5} {'paid':>5} {'bid=a+b*value':>14} {'bid e/m/l':>12}")
for b in show:
    P = prof[b]
    e, mi, la = P["tiles_ph"]
    a0, b1 = P["fit"]
    be, bm, bl = P["bid_ph"]
    print(f"{label(b):18} {P['tiles']:5.1f} {e:5.1f}/{mi:4.1f}/{la:4.1f} {P['first3']:6.2f} {P['last5']:5.2f} {P['paid']:5.1f} {a0:6.1f}+{b1:4.2f}*v {be:4.0f}/{bm:3.0f}/{bl:3.0f}")

print("\n== Coins over the match (avg balance at auction #) and broke share (<10 coins) ==")
for b in show:
    P = prof[b]
    tr = " ".join(f"{k}:{v:4.0f}" for k, v in P["traj"].items())
    print(f"{label(b):18} {tr}   broke {100*P['broke']:4.0f}%")

print("\n== Words ==")
print(f"{'bot':18} {'words':>5} {'len':>4} {'pts/w':>5} {'7+pts':>5} {'8+/m':>5} {'1stWordAt':>9} {'rackWhenPlay':>12} {'end5 words/pts':>15} {'wasted':>6}")
for b in show:
    P = prof[b]
    print(f"{label(b):18} {P['words']:5.1f} {P['wlen']:4.1f} {P['wrew']:5.1f} {100*P['long_share']:4.0f}% {P['eight_plus']:5.2f} {P['first_word_round']:9.1f} {P['held_at_play']:12.1f} {P['end_words']:7.2f}/{P['end_pts']:5.1f} {P['wasted']:6.1f}")

print("\n== Tile mix won ==")
for b in show:
    P = prof[b]
    print(f"{label(b):18} vowels {100*P['vowel_share_won']:3.0f}%   high-value (4+) {100*P['hi_share_won']:3.0f}%")

# ---------- what separates match winners ----------
print("\n== Match winners vs everyone else (all real bots, all matches) ==")
W = collections.defaultdict(list); O = collections.defaultdict(list)
for mid in parts:
    if len(parts[mid]) < 6:
        continue
    n = len(auc[mid])
    for b in parts[mid]:
        if b in sim:
            continue
        won = [a for a in auc[mid] if a["win"] == b]
        ws = [w for w in words[mid] if w["bot"] == b]
        tgt = W if place(mid, b) == 1 else O
        tgt["tiles"].append(len(won))
        tgt["early tiles (first third)"].append(sum(1 for a in won if a["r"] < 23))
        tgt["late tiles (last third)"].append(sum(1 for a in won if a["r"] >= 46))
        tgt["avg price paid"].append(st.mean(a["paid"] for a in won) if won else 0)
        tgt["words"].append(len(ws))
        tgt["7+ letter words"].append(sum(1 for w in ws if len(w["w"]) >= 7))
        tgt["8+ letter words"].append(sum(1 for w in ws if len(w["w"]) >= 8))
        tgt["coins left"].append(parts[mid][b][0])
        tgt["high-value tiles (4+)"].append(sum(1 for a in won if VAL[a["L"]] >= 4))
        tgt["score"].append(parts[mid][b][1])
for k in W:
    print(f"  {k:28s} winners {st.mean(W[k]):6.1f}   others {st.mean(O[k]):6.1f}")

# ---------- letter economics: points produced per coin ----------
print("\n== Letter economics (field): price vs points it ends up producing ==")
used = collections.Counter(); bought = collections.Counter(); pts = collections.Counter(); spent = collections.Counter()
for mid in auc:
    for b in parts[mid]:
        q = collections.defaultdict(list)
        for a in auc[mid]:
            if a["win"] == b:
                q[a["L"]].append(a)
                bought[a["L"]] += 1
                spent[a["L"]] += a["paid"]
        for w in sorted((w for w in words[mid] if w["bot"] == b), key=lambda w: w["t"]):
            base = sum(VAL[c] for c in w["w"])
            for c in w["w"]:
                if q[c] and q[c][0]["t"] <= w["t"]:
                    q[c].pop(0)
                    used[c] += 1
                    pts[c] += w["rew"] * VAL[c] / max(1, base)
rowsL = []
for L in sorted(bought):
    if bought[L] < 30:
        continue
    util = used[L] / bought[L]
    ppt = pts[L] / max(1, used[L])
    price = spent[L] / bought[L]
    rowsL.append((util * ppt / price, L, price, util, ppt))
rowsL.sort(reverse=True)
print(f"  {'L':2} {'price':>5} {'used%':>6} {'pts when used':>13} {'pts per coin':>12}")
for v, L, price, util, ppt in rowsL:
    print(f"  {L:2} {price:5.1f} {100*util:5.0f}% {ppt:13.1f} {v:12.2f}")
