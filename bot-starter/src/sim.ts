// Offline match simulator mirroring the server rules (spacetimedb/src/game.ts):
// 6 seats, 5-tile start, 100 coins, 98-tile bag, 1 sealed-bid auction per
// tile (Vickrey: winner pays the second-highest bid), match ends the moment
// the last auction closes.
//
// Every variant plays the SAME games: game g uses seed+g for the bag and all
// opponent randomness, so differences between variants are the strategy,
// not luck.
//
// Run:  npx tsx src/sim.ts <games> <room> [seed] [tag]
//   rooms: arena  = ours + 2 copies of the current default bot + 1 LUCENT clone + 2 field bots
//          tough  = ours + 2 LUCENT clones + 3 field bots
//          field  = ours + 5 field bots (bids calibrated to ~650 live matches)
//          mirror = ours + 3 copies of the current default bot + 2 field bots
//          sims   = ours + 5 server simulated bots
// Override "ours" knobs with env vars, e.g. P_volumeA=11 P_endCoinPerPoint=4.
// Each run appends a line to sim-results.tsv.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAG_COUNTS,
  LETTER_VALUE,
  PARAMS,
  chooseWord,
  decideBid,
  rackFit,
  wordReward,
} from "./strategy.js";

type Params = typeof PARAMS;
const BASE: Params = { ...PARAMS };
const VARIANT: Params = { ...PARAMS };
for (const k of Object.keys(PARAMS) as (keyof Params)[]) {
  const v = process.env[`P_${k}`];
  if (v !== undefined) (VARIANT as Record<string, number>)[k] = Number(v);
}
function withParams<T>(p: Params, fn: () => T): T {
  Object.assign(PARAMS, p);
  return fn();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDS = fs
  .readFileSync(path.join(here, "..", "..", "spacetimedb", "wordlist.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2);
const BY_LENGTH = [...WORDS].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

// ---- Deterministic randomness: hash(seed, a, b, c) -> [0, 1) ----
function hash01(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}
function gaussH(...xs: number[]): number {
  const u = Math.max(1e-12, hash01(...xs, 1));
  const v = hash01(...xs, 2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

type Kind = "ours" | "base" | "lucent" | "field" | "Cheapskate" | "ValueBidder" | "Aggressive";
interface Player {
  kind: Kind;
  balance: number;
  score: number;
  rack: Map<string, number>;
  start: Map<string, number>;
  won: number;
}

const add = (m: Map<string, number>, c: string, n = 1) => m.set(c, (m.get(c) ?? 0) + n);
function rackSize(r: Map<string, number>) {
  let n = 0;
  for (const v of r.values()) n += v;
  return n;
}
function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c]! > (rack.get(c) ?? 0)) return false;
  }
  return true;
}
function longest(rack: Map<string, number>, minLen: number): string | null {
  const total = rackSize(rack);
  for (const w of BY_LENGTH) {
    if (w.length < minLen) break;
    if (w.length <= total && canSpell(w, rack)) return w;
  }
  return null;
}
function play(p: Player, word: string) {
  for (const c of word) {
    const n = p.rack.get(c)! - 1;
    if (n === 0) p.rack.delete(c);
    else p.rack.set(c, n);
  }
  const r = wordReward(word);
  p.balance += r;
  p.score += r;
}

// Server sim bots (game.ts decideBid): face value +/- 2 jitter.
function simBid(kind: Kind, letter: string, balance: number, noise: number): number {
  const v = LETTER_VALUE[letter] ?? 1;
  const vowel = "AEIOU".includes(letter);
  const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (vowel ? 4 : 2);
  const jitter = Math.floor(noise * 5) - 2;
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}
// Field bots: lognormal around 5 + 2.05 x value, calibrated so the top and
// second-highest of 5 bids match live data (A ~12/9, C ~19/14, J ~38/28).
function fieldBid(letter: string, balance: number, remaining: number, z: number): number {
  const face = LETTER_VALUE[letter] ?? 1;
  const sigma = remaining < 23 ? 0.6 : 0.45;
  return Math.max(0, Math.min(balance, Math.round((5 + 2.05 * face) * Math.exp(sigma * z))));
}
// LUCENT clone: ~9 + 2.5 x value on nearly every tile, shaded by rack fit,
// paced by coins, higher late (its winning bids track that line).
function lucentBid(letter: string, p: Player, remaining: number, z: number): number {
  if (remaining <= 0) return 0;
  const face = LETTER_VALUE[letter] ?? 1;
  const fit = rackFit({ letter, myBalance: p.balance, myRack: p.rack });
  const pace = Math.min(1.3, Math.max(0.3, p.balance / Math.max(1, (remaining + 1) * 2)));
  const late = remaining < 23 ? 1.25 : 1;
  return Math.max(0, Math.min(p.balance, Math.round((9 + 2.5 * face) * fit * pace * late * Math.exp(0.15 * z))));
}

const SIM_KINDS: Kind[] = ["Cheapskate", "ValueBidder", "Aggressive"];
function roomKinds(room: string, seed: number): Kind[] {
  switch (room) {
    case "arena":
      return ["ours", "base", "base", "lucent", "field", "field"];
    case "tough":
      return ["ours", "lucent", "lucent", "field", "field", "field"];
    case "field":
      return ["ours", "field", "field", "field", "field", "field"];
    case "mirror":
      return ["ours", "base", "base", "base", "field", "field"];
    default:
      return ["ours", ...[1, 2, 3, 4, 5].map((i) => SIM_KINDS[Math.floor(hash01(seed, 999, i) * 3)]!)];
  }
}

function playMatch(seed: number, room: string): Player[] {
  // Shuffle the bag deterministically.
  const bag: string[] = [];
  for (const [c, n] of Object.entries(BAG_COUNTS)) for (let i = 0; i < n; i++) bag.push(c);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, 1, i) * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  const players: Player[] = roomKinds(room, seed).map((kind) => ({
    kind,
    balance: 100,
    score: 0,
    rack: new Map(),
    start: new Map(),
    won: 0,
  }));
  for (const p of players)
    for (let i = 0; i < 5; i++) {
      const c = bag.pop()!;
      add(p.rack, c);
      add(p.start, c);
    }
  const auctioned = new Map<string, number>();
  const paramsFor = (p: Player) => (p.kind === "ours" ? VARIANT : BASE);
  const smart = (p: Player) =>
    p.kind === "ours" || p.kind === "base" || p.kind === "lucent" || p.kind === "field";

  let round = 0;
  let letter = bag.pop();
  while (letter !== undefined) {
    const remaining = bag.length; // auctions after this one
    add(auctioned, letter);
    // Word plays happen between auctions.
    for (const p of players) {
      if (!smart(p)) continue;
      withParams(paramsFor(p), () => {
        for (let guard = 0; guard < 20; guard++) {
          const w = chooseWord({
            myRack: p.rack,
            dictionary: WORDS,
            remainingAuctions: remaining,
            myBalance: p.balance,
          });
          if (!w) break;
          play(p, w);
        }
      });
    }
    const bids: { p: Player; amount: number; tie: number }[] = [];
    players.forEach((p, seat) => {
      const z = gaussH(seed, round, seat);
      let amount = 0;
      if (p.kind === "ours" || p.kind === "base") {
        const unseen = new Map<string, number>();
        for (const [c, n] of Object.entries(BAG_COUNTS)) {
          unseen.set(c, Math.max(0, n - (auctioned.get(c) ?? 0) - (p.start.get(c) ?? 0)));
        }
        const maxOpp = Math.max(...players.filter((q) => q !== p).map((q) => q.balance));
        amount = withParams(paramsFor(p), () =>
          decideBid({
            letter: letter!,
            myBalance: p.balance,
            myRack: p.rack,
            dictionary: WORDS,
            remainingAuctions: remaining,
            auctionType: "Vickrey",
            unseen,
            maxOpponentBalance: maxOpp,
          }),
        );
      } else if (p.kind === "lucent") amount = lucentBid(letter!, p, remaining, z);
      else if (p.kind === "field") amount = fieldBid(letter!, p.balance, remaining, z);
      else amount = simBid(p.kind, letter!, p.balance, hash01(seed, round, seat, 7));
      if (amount > 0) bids.push({ p, amount, tie: hash01(seed, round, seat, 3) });
    });
    bids.sort((a, b) => b.amount - a.amount || a.tie - b.tie);
    const [first, second] = bids;
    if (first) {
      const paid = second ? second.amount : Math.min(1, first.amount);
      if (first.p.balance >= paid) {
        first.p.balance -= paid;
        add(first.p.rack, letter);
        first.p.won++;
        if (!smart(first.p)) {
          const w = longest(first.p.rack, 3);
          if (w) play(first.p, w);
        }
      }
    }
    round++;
    letter = bag.pop(); // when the bag is empty the match ends: no more plays
  }
  return players;
}

// ---- Run ----
const games = Number(process.argv[2] ?? 100);
const room = process.argv[3] ?? "arena";
const seedArg = Number(process.argv[4] ?? 1);
const seed0 = seedArg * 100000;
const tag = process.argv[5] ?? "variant";

const rankOf = (ps: Player[], i: number) => {
  const s = ps[i]!.score;
  let r = 1;
  ps.forEach((q, j) => {
    if (j === i) return;
    if (q.score > s) r += 1;
    else if (q.score === s) r += 0.5;
  });
  return r;
};
const ranks: number[] = [];
let wins = 0;
let score = 0;
let coins = 0;
let won = 0;
let wasted = 0;
let baseRank = 0;
let baseN = 0;
const t0 = Date.now();
for (let g = 0; g < games; g++) {
  const ps = playMatch(seed0 + g, room);
  const r = rankOf(ps, 0);
  ranks.push(r);
  if (r === 1) wins++;
  score += ps[0]!.score;
  coins += ps[0]!.balance;
  won += ps[0]!.won;
  wasted += rackSize(ps[0]!.rack);
  ps.forEach((p, i) => {
    if (p.kind === "base") {
      baseRank += rankOf(ps, i);
      baseN++;
    }
  });
}
const mean = ranks.reduce((a, b) => a + b, 0) / games;
const sd = Math.sqrt(ranks.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, games - 1));
const se = sd / Math.sqrt(games);
console.log(
  `[${tag}] rank ${mean.toFixed(2)} ±${se.toFixed(2)}  win ${((100 * wins) / games).toFixed(0)}%  score ${(score / games).toFixed(1)}  coinsLeft ${(coins / games).toFixed(0)}  tilesWon ${(won / games).toFixed(1)}  wasted ${(wasted / games).toFixed(1)}` +
    (baseN ? `  baseCopiesRank ${(baseRank / baseN).toFixed(2)}` : "") +
    `  (${games} ${room}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`,
);
// Per-game placements, for game-by-game (paired) comparisons between variants.
fs.mkdirSync(path.join(here, "..", "sim-ranks"), { recursive: true });
fs.writeFileSync(
  path.join(here, "..", "sim-ranks", `${room}-${seedArg}-${games}-${tag}.json`),
  JSON.stringify(ranks),
);
const changed = Object.fromEntries(
  Object.entries(VARIANT).filter(([k, v]) => (BASE as Record<string, number>)[k] !== v),
);
fs.appendFileSync(
  path.join(here, "..", "sim-results.tsv"),
  [
    new Date().toISOString(),
    tag,
    room,
    games,
    seedArg,
    mean.toFixed(3),
    se.toFixed(3),
    (wins / games).toFixed(3),
    (score / games).toFixed(1),
    (coins / games).toFixed(1),
    (wasted / games).toFixed(2),
    JSON.stringify(changed),
  ].join("\t") + "\n",
);
