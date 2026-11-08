# ScrabbleBot — Handoff (Rowin'Boats)

Written 2026-11-07 ~21:30 CST. Owner: Isaac (UT Dallas student, not a developer — explain plainly, be honest about uncertainty, validate with numbers).

## 1. What this is

- Game: **ScrabbleBot** — https://scrabblebot.spacetimedb.com (SpacetimeDB database `scrabblebot` on maincloud). It is a **letter auction**, not board Scrabble.
- Our team/bot: **Rowin'Boats**, bot id **202**. Isaac's spacetimedb.com account is linked (web identity `c200557470…`).
- Repo: `C:\Users\Isaac\OneDrive - The University of Texas at Dallas\Desktop\Claude projects\scrabblebot` (clone of github.com/clockworklabs/scrabblebot). Our code lives in `bot-starter/`.
- Deadline: Isaac said "due in 5 hrs" at ~4:20 PM; the **website shows no deadline or submission** — "submission" = bot registered and connected. Only one tournament has ever run (Tournament #1, ended Oct 25, won by K-13). Ask Isaac where the real deadline/judging is.

## 2. Game rules (from `spacetimedb/src/game.ts`)

- 6 seats, each bot starts with 5 tiles + 100 coins. 98-tile bag, no blanks → **68 auctions**, **1 second each**, matches last ~70 s.
- Sealed bids, **Vickrey** (winner pays 2nd-highest bid). Bids can be replaced before close. Bid > balance is rejected.
- Play any dictionary word from your own tiles any time. Reward = sum of letter values × length multiplier (1× ≤3, 1.5× 4, 2× 5, 2.5× 6, **3× 7+**). Reward adds to score AND coins.
- **Score = word rewards only. Leftover coins are worth 0.** Match ends the instant the last auction closes (tiles won in the final auction are useless; words must be submitted before it closes).
- Lobby: bots call `join_lobby`; match starts when 6 real bots join or after a 90 s timer (empty seats get weak simulated bots).
- One team per spacetimedb.com account, one bot per team (others with "10+ bots" use many accounts — do NOT create accounts).
- Tournaments: admin opens registration; the bot must register itself from its own process (our bot auto-registers; `AUTO_TOURNAMENT=0` disables). Offline registered bots still get seated and lose.

## 3. How to run / stop

PowerShell, from `bot-starter`:

```
$env:AB_TEST='1'; powershell -ExecutionPolicy Bypass -File .\start-bot.ps1
```

- Stop: Ctrl+C. `start-bot.ps1` refreshes PATH (Node), sets `BOT_NAME=rowinboats`, uses the saved token `.token-rowinboats` (gitignored; never print it).
- **Live-editable files (no restart needed, read at the start of each match):**
  - `ab-rotation.txt` — versions to rotate, e.g. `V3` or `B,V3`. Currently **`V3`**.
  - `lobby-delay.txt` — ms to wait before rejoining the lobby after a match. Currently **`8000`** (avoids being re-seated with the same strong cluster of bots).
  - `variants.json` (optional) — add/override versions as `{ "V6": { ...PARAMS } }`.
- Raise the bot process to AboveNormal priority if running other CPU work.
- Tools: Node 24 (winget, user scope). SpacetimeDB CLI 2.14.1: call `%LOCALAPPDATA%\SpacetimeDB\bin\2.14.1\spacetimedb-cli.exe` directly (the `current` junction fails in the sandbox). CLI is logged in as Isaac. JSON args with quotes get mangled on Windows — use the website forms instead.
- Bindings already generated in `bot-starter/src/module_bindings` (`npm run generate` not needed).
- PC clock runs ~1 s ahead of the server ("heard N ms after open" logs read ~1 s high). Normal heard ≈ 1700–2800 ms.

## 4. Code map (`bot-starter/`)

- `src/strategy.ts` — all decision logic. `PARAMS` (tunable knobs), `VARIANTS` (A, B, V3, V4, V5), `decideBid`, `chooseWord`, `endgameWords`, `planWords` (endgame word-set search), `rackFit`, potential/value model, `MARKET_PRICE` table.
- `src/index.ts` — SpacetimeDB client: lean subscriptions, per-match subs, A/B logging (`ab-log.tsv`), lobby delay, auto-tournament registration, pending-spend tracking, endgame batch word submit.
- `src/sim.ts` — offline simulator (deterministic seeds). Rooms: `arena` (ours vs 2 copies of current defaults + LUCENT clone + 2 field bots), `tough`, `field`, `mirror`, `sims`. Override knobs with `P_<name>=value`.
- `tune.sh` — run variants in parallel on the same games (MAXJOBS=3, Idle priority). `paired.py` — game-by-game comparison.
- `src/strategy.test.ts` — 9 unit tests (`npm test`).
- `analysis/`: `fetch.sh` (download match data), `top5.py`, `leaders.py`, `pattern.py` (leader profiling), `record.sh`, `ab-report.sh`, `next-event.sh` (per-match watcher → `ab-results.tsv`).
- Data files: `ab-log.tsv` (match → version), `ab-results.tsv` (per-match results), `sim-results.tsv`, `sim-ranks/`.

## 5. Versions and live results (Nov 7, ~5:30–9:30 PM)

| Version | What it is | Live matches | Avg place | Wins | Avg score |
|---|---|---|---|---|---|
| **V3 (recommended, current)** | rack-need bidding (normalPace 0.7, maxAggression 4), hold weak words (minLongReward 33), steep high-value bids (volumeA 12, volumeB 3.5) | 25 | **2.92** | **7** | **84.9** |
| B | rack-need bidding + minLongReward 27 | 19 | 3.05 | 4 | 79.3 |
| V4 | V3 + no early discount + Q-without-U fix + late 1.35 | 6 | 3.67 | 1 | 80.3 |
| A | defaults (phase-shaped bidding) | 7 | 3.71 | 0 | 72.3 |
| V5 | hybrid + price-aware bidding (roomFollow) | 3 | 5.67 | 0 | 59.7 |

Defaults (`PARAMS`) = version A: volumeA 13.5, volumeB 3.2, earlyVolumeMult 0.9, lateVolumeMult 1.25, normalPace 1, maxAggression 3, exact endgame bids, planner, late floor.

## 6. Hard-won lessons

1. **Subscriptions must stay lean.** The starter's `subscribeToAllTables` and full history tables (156k lobby members, 1.8M auctions) made bids arrive seconds late. Use views `open_lobbies`/`open_lobby_members` and JOIN subscriptions on `match_participant WHERE bot_id = 202`.
2. **Never run heavy simulations while the bot is live** (8 parallel sims → 95 s bid round trips). ≤3 sims at Idle priority, bot at AboveNormal.
3. Restarts mid-lobby cause a race (old process gets seated in next match). The file-based rotation/delay now avoids restarts.
4. The simulator is useful for relative comparisons but its opponents bid like the older, softer field; changes aimed at the current aggressive field (V4, V5) looked fine in sim and failed live. Trust live A/B data.
5. Endgame: plan the whole set of final words and submit them together; never bid on the final tile.

## 7. What the leaders do (from public data)

- Market price ≈ 6.5 + 2.4 × letter value; high-value letters (Q/Z/J/X) return 2–4× more points per coin than 1-point letters.
- **Current leaders** (RackMaw-Champion-Ctl 66% wins, LexForge-* family, GodOfThudner, N1gel): bid ~0.8–0.9× market early, **1.25–1.65× late**, win ~6 late tiles (we win ~2), pay 1.3–1.4× for tiles that finish a word, first word around auction 30–35, 31–34 points/word.
- Tournament #1 top 3 (K-13, TileShark, Waupus): one 50–66 point "blockbuster" per match built around two high-value letters (QUAVERED, COZYING, QWERTYS), never cash weak 7-letter words.
- Our bot's remaining weakness: front-loaded buying, weak late buying, weak premium for word-finishing tiles, often 9–13 tiles and 15–40 unspent coins in losses.

## 8. Suggested next steps

- **V6 (designed, not built):** earlyVolumeMult 0.8, lateVolumeMult 1.5, bigger word-finishing premium (e.g. normalPace 0.5, maxAggression 5), minLongReward 33, keep V3's volumeA 12 / volumeB 3.5. Add via `variants.json` and alternate `V3,V6` in `ab-rotation.txt`; judge on ≥10 live matches each.
- Keep the lobby delay; consider tuning 5–15 s.
- Watch the tournament page; keep the bot online if one opens.

## 9. Etiquette for the next AI

- Isaac signs in himself; never handle passwords or create accounts; never print the bot token.
- Post match results with links: `https://scrabblebot.spacetimedb.com/matches/<id>`.
- Be candid when a change doesn't help; small samples (5–10 matches) are noisy.
