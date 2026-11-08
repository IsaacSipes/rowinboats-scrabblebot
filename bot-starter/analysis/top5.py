import sys, collections, statistics as st, re, json
from datetime import datetime

D = sys.argv[1]
TOP = {"18": "LUCENT", "171": "GodOfThudner", "114": "Bron", "193": "RackMaw", "138": "Waupus", "202": "Rowin'Boats (us)"}
VAL = dict(A=1,B=3,C=3,D=2,E=1,F=4,G=2,H=4,I=1,J=8,K=5,L=1,M=3,N=1,O=1,P=3,Q=10,R=1,S=1,T=1,U=1,V=4,W=4,X=8,Y=4,Z=10)

def rows(f):
    out = []
    for line in open(f"{D}/{f}", encoding="utf-8"):
        p = [x.strip() for x in line.split("|")]
        if len(p) >= 3 and p[0].isdigit():
            out.append([x.strip('"') for x in p])
    return out

def ts(s):
    s = s.replace("+00:00", "")
    if "." in s:
        a, b = s.split(".")
        s = a + "." + b[:6]
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%f").timestamp()
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").timestamp()

def opt(s):
    m = re.search(r"some = (\d+)", s)
    return m.group(1) if m else None

matches = {}
for mid, status, atype, created in rows("t_matches.txt"):
    matches[mid] = dict(status=status, type="first" if "first" in atype.lower() else "vickrey")
ended = {m for m, v in matches.items() if "ended" in v["status"]}

top = {a: int(t) for a, m, t in rows("t_top.txt")}
auc = collections.defaultdict(list)
for mid, aid, letter, win, paid, closed in rows("t_auc.txt"):
    if mid in ended:
        auc[mid].append(dict(aid=int(aid), letter=letter, win=opt(win), paid=int(paid), t=ts(closed), top=top.get(aid)))
words = collections.defaultdict(list)
for mid, bot, word, rew, played in rows("t_words.txt"):
    if mid in ended:
        words[mid].append(dict(bot=bot, word=word, rew=int(rew), t=ts(played)))
parts = collections.defaultdict(dict)
for mid, bot, bal, score in rows("t_parts.txt"):
    if mid in ended:
        parts[mid][bot] = (int(bal), int(score))

# Per-match round index for each auction, and the round at which each word was played.
for mid, lst in auc.items():
    lst.sort(key=lambda a: a["aid"])
    for i, a in enumerate(lst):
        a["round"] = i
    n = len(lst)
    for w in words[mid]:
        r = sum(1 for a in lst if a["t"] <= w["t"])
        w["round"] = r
        w["left"] = n - r  # auctions remaining when played

def phase(r):
    return "early" if r < 23 else ("mid" if r < 46 else "late")

report = {}
for bot, name in TOP.items():
    ms = [m for m in parts if bot in parts[m] and m in auc]
    if not ms:
        continue
    S = dict(n=len(ms))
    scores = [parts[m][bot][1] for m in ms]
    S["avg_score"] = st.mean(scores)
    S["win_rate"] = st.mean(1 if parts[m][bot][1] == max(s for _, s in parts[m].values()) else 0 for m in ms)
    S["coins_left"] = st.mean(parts[m][bot][0] for m in ms)
    S["field_avg"] = st.mean(s for m in ms for b, (_, s) in parts[m].items() if b != bot)
    won = [a for m in ms for a in auc[m] if a["win"] == bot]
    S["tiles_won_per_match"] = len(won) / len(ms)
    S["avg_paid"] = st.mean(a["paid"] for a in won) if won else 0
    S["avg_bid_when_won"] = st.mean(a["top"] for a in won if a["top"] is not None) if won else 0
    for ph in ("early", "mid", "late"):
        w = [a for a in won if phase(a["round"]) == ph]
        S[f"won_{ph}"] = len(w) / len(ms)
        S[f"paid_{ph}"] = st.mean(a["paid"] for a in w) if w else 0
        S[f"bid_{ph}"] = st.mean(a["top"] for a in w if a["top"] is not None) if w else 0
    # Which letters they buy, vs how often each letter comes up.
    seen = collections.Counter(a["letter"] for m in ms for a in auc[m])
    got = collections.Counter(a["letter"] for a in won)
    S["take_rate"] = {l: got[l] / seen[l] for l in sorted(seen)}
    S["bid_by_letter"] = {l: round(st.mean(a["top"] for a in won if a["letter"] == l and a["top"] is not None), 1)
                          for l in sorted(got) if any(a["top"] is not None for a in won if a["letter"] == l)}
    ws = [w for m in ms for w in words[m] if w["bot"] == bot]
    S["words_per_match"] = len(ws) / len(ms)
    lens = collections.Counter(min(len(w["word"]), 9) for w in ws)
    S["word_len_share"] = {k: round(v / max(1, len(ws)), 2) for k, v in sorted(lens.items())}
    pts = collections.Counter()
    for w in ws:
        pts[min(len(w["word"]), 9)] += w["rew"]
    tot = sum(pts.values()) or 1
    S["points_by_len"] = {k: round(v / tot, 2) for k, v in sorted(pts.items())}
    S["avg_word_len"] = st.mean(len(w["word"]) for w in ws) if ws else 0
    S["avg_reward_per_word"] = st.mean(w["rew"] for w in ws) if ws else 0
    S["short_words_mid"] = sum(1 for w in ws if len(w["word"]) < 7 and w["left"] > 5) / len(ms)
    S["words_last5"] = sum(1 for w in ws if w["left"] <= 5) / len(ms)
    S["word_phase"] = dict(collections.Counter(phase(w["round"]) for w in ws))
    played_letters = sum(len(w["word"]) for w in ws)
    S["tiles_wasted_per_match"] = (5 * len(ms) + len(won) - played_letters) / len(ms)
    # High-value letters: how much they pay for Q/Z/X/J/K
    S["examples"] = [w["word"] for w in ws[-12:]]
    S["first_price_matches"] = sum(1 for m in ms if matches[m]["type"] == "first")
    report[name] = S

# Field-wide: what do the top two bids look like per letter/phase (for simulator calibration)?
field = collections.defaultdict(list)
for m, lst in auc.items():
    if matches[m]["type"] != "vickrey":
        continue
    for a in lst:
        if a["top"] is not None and a["win"]:
            field[(a["letter"], phase(a["round"]))].append((a["top"], a["paid"]))
calib = {}
for (l, ph), v in field.items():
    calib.setdefault(l, {})[ph] = dict(top=round(st.mean(x for x, _ in v), 1), second=round(st.mean(y for _, y in v), 1), n=len(v))
json.dump(dict(report=report, calib=calib), open(f"{D}/top5.json", "w"), indent=1)

for name, S in report.items():
    print(f"\n=== {name}  ({S['n']} matches, {S['first_price_matches']} first-price)")
    print(f" score {S['avg_score']:.0f} (field {S['field_avg']:.0f}), win {100*S['win_rate']:.0f}%, coins left {S['coins_left']:.0f}")
    print(f" tiles won/match {S['tiles_won_per_match']:.1f}  [early {S['won_early']:.1f} / mid {S['won_mid']:.1f} / late {S['won_late']:.1f}]  wasted tiles/match {S['tiles_wasted_per_match']:.1f}")
    print(f" bid when won {S['avg_bid_when_won']:.1f} (paid {S['avg_paid']:.1f})  by phase bid/paid: early {S['bid_early']:.0f}/{S['paid_early']:.0f}  mid {S['bid_mid']:.0f}/{S['paid_mid']:.0f}  late {S['bid_late']:.0f}/{S['paid_late']:.0f}")
    print(f" words/match {S['words_per_match']:.1f}, avg len {S['avg_word_len']:.1f}, avg reward {S['avg_reward_per_word']:.1f}; short words mid-game/match {S['short_words_mid']:.2f}; words in last 5 auctions/match {S['words_last5']:.2f}")
    print(f" points by word length {S['points_by_len']}")
    tr = S["take_rate"]
    hi = sorted(tr, key=lambda l: -tr[l])[:8]
    print(f" letters they grab most (share of auctions won): {', '.join(f'{l} {100*tr[l]:.0f}%' for l in hi)}")
    print(f" recent words: {', '.join(S['examples'])}")
