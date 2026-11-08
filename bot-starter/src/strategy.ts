// Bidding and word-playing strategy.
//
// The game, in money terms:
//  - Score comes ONLY from playing words. Coins left at the end are worth 0.
//  - Word reward = letter values x length multiplier (1x <=3, 1.5x 4, 2x 5,
//    2.5x 6, 3x 7+). A 7-letter word pays triple, so we hoard letters and
//    play long words instead of cashing short ones.
//  - The match ends the moment the last auction closes, so leftover tiles
//    are wasted: dump everything into words in the final few auctions.
//
// Bidding: a letter is worth how much it raises our "rack potential" — the
// best word we could plausibly finish, discounted by the odds of buying the
// letters we're still missing. That value (in points) is scaled by how
// plentiful our coins are versus the auctions left, since spare coins at
// the end are worthless.

// Standard Scrabble letter values.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// The bag: standard Scrabble distribution, no blanks, 98 tiles.
export const BAG_COUNTS: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

// ---- Tunable knobs (the simulator in sim.ts is for tuning these) ----
export const PARAMS = {
  // Chance we win a given auction for a letter we want.
  winRate: 0.45,
  // Cap on the chance we ever get a missing letter.
  maxAcquire: 0.85,
  // Coins per remaining auction that counts as "normal" spending pace.
  // Tuned against bots bidding live market prices (~10-13 coins/tile):
  // 1.5 won 5% of simulated matches, 0.5 won 35-55%.
  // With volume buying on, 1.0 (+ maxAggression 3) avoids overpaying for
  // single tiles early (live: paid 25 for a W, 21 for a C) at no sim cost.
  normalPace: 1,
  // Bid multiplier limits.
  minAggression: 0.6,
  maxAggression: 3,
  // Extra value for letters that appear in many long words (flexibility).
  flexBonus: 4,
  // Start dumping all letters into words when this many auctions remain.
  endgameAuctions: 3,
  // Below this balance, cash a 5+ letter word to fund bidding.
  brokeBalance: 6,
  // First-price auctions: never bid more than this x the usual price.
  firstPriceShade: 1.1, // sim: 1.1 won 70%, 1.3 won 53%, 1.6 won 35%
  // Late-game spending: in the last `lateWindow` auctions, bid up to
  // lateMaxMarket x the usual price on useful letters (value >= lateMinValue)
  // when coins exceed lateSpendRate per remaining auction.
  // sim (300 games each): off = 34% wins, 28 coins wasted; on = 43%, 15.
  lateWindow: 25,
  lateMinValue: 0.8,
  lateSpendRate: 2,
  lateMaxMarket: 1.3,
  // Volume buying, learned from the top bots (LUCENT wins ~23 tiles a match
  // by bidding ~ A + B x letter value on nearly everything and paying the
  // second price). volumeB = 0 turns it off.
  // Leaders' winning bids fit ~10.6-11.5 + 2.8-3.3 x value; high-value
  // letters return 2-4x more points per coin than 1-point ones. Arena sim
  // (two fresh 80-game sets): 10.5 + 3.2 x value beat 9 + 2.5 x by
  // 0.14 / 0.13 placement and lifted wins from ~27% to ~35%.
  // Live 19:35: after leader clones joined, 73% of our lost auctions were
  // lost by <= 3 coins. Winner pays the 2nd-highest bid, so +3 here buys
  // those tiles for ~3 coins more each.
  volumeA: 13.5,
  volumeB: 3.2,
  // Coins per remaining auction we can afford to spend at full volume.
  volumeCost: 2,
  // Endgame: in the last `exactWindow` auctions, a tile is worth exactly the
  // points it adds to the best SET of words we can still play, and coins are
  // nearly worthless, so bid up to endCoinPerPoint coins per point gained.
  exactWindow: 6,
  endCoinPerPoint: 3,
  // How many words the endgame planner may combine.
  maxPlanWords: 4,
  // Mid-game: when a 7+ word is playable, prefer one whose leftover letters
  // keep more potential (0 = just take the highest-scoring word).
  leaveWeight: 0,
  // Coins we expect to earn back from future words, per remaining auction.
  // Counting them as budget lets us bid harder early (top bots earn ~2 per
  // auction). 0 = budget only from the coins we hold.
  incomeRate: 0,
  // A tile won in the second-to-last auction must be played within ~1 s
  // before the match ends; live server lag sometimes makes that too late.
  // Scale its endgame value by this (the simulator has no lag).
  lastPlayableDiscount: 0.6,
  // Mid-game cashing: once the rack holds this many tiles, also play the
  // best 6-letter word (coins back sooner). 99 = off.
  bigRack: 99,
  // Volume buying: above this share of vowels on the rack, more vowels
  // get a lower bid (1-point letters return ~0.2 points per coin).
  vowelCap: 0.5,
  // Mid-match cashing (what the top 3 bots do: ~20% of their points come
  // from 5-6 letter words around a Q/J/X/Z/W/F/V, played mid-match): play
  // the best 5-6 letter word once it's worth at least this many points.
  // 0 = off (hold out for 7+ letters).
  midCashMin: 0,
  // Phase-shaped volume bids (current leaders bid ~0.85-0.95x the market
  // line early and ~1.2-1.35x in the last third, and win most tiles late).
  // Early = more than 45 auctions left; late = fewer than 23 left.
  // Sim (80 games): 0.9 / 1.25 -> placement 2.59 -> 2.51, wins 25% -> 34%.
  earlyVolumeMult: 0.9,
  lateVolumeMult: 1.25,
  // Before the last third, only cash a 7+ letter word if it's worth at
  // least this much (leaders hold for ~32-36 point words; ours averaged 26).
  // Bigger racks (>= 11 tiles) play regardless. 0 = off.
  minLongReward: 0,
  // Bid share for a Q when we hold no U (QINTARS, QAT need no U).
  qNoUFit: 0.35,
  // Price-aware bidding: scale volume bids and the late floor by how
  // expensive tiles are selling in THIS room (paid / usual price), so we
  // don't finish with unspent coins in pricey rooms. 0 = off, 1 = follow.
  roomFollow: 0,
  qualityWords: 0,
  qualityCashMin: 32,
  qualityCashBalance: 35,
  selectiveSpending: 0,
  speculativeEarlyMult: 0.85,
  speculativeMidMult: 0.95,
  purchaseReserve: 25,
  completionMinGain: 8,
};

// ---- A/B testing: named settings the live bot alternates between ----
const DEFAULT_PARAMS = { ...PARAMS };
export const VARIANTS: Record<string, Partial<typeof PARAMS>> = {
  // A: the current version (phase-shaped bidding).
  A: {},
  // B: bid harder on tiles that complete a word (leaders pay ~25% more for
  // tiles they use soon) and hold weak 7-letter words for better ones
  // (leaders average 31-36 points per word; we averaged 26).
  B: { normalPace: 0.7, maxAggression: 4, minLongReward: 27 },
  // V3: the Tournament #1 top-3 pattern (K-13, TileShark, Waupus): one
  // 50-66 point word per match built around two high-value letters, never a
  // weak 7-letter word. Hold for 33+ point words and pay more for valuable
  // letters, on top of B's rack-need bidding.
  V3: { normalPace: 0.7, maxAggression: 4, minLongReward: 33, volumeA: 12, volumeB: 3.5 },
  // V4: V3's live losses came with too few tiles (9-13 vs 16+ in its wins,
  // and fewer early tiles). Drop the early discount, bid fairly on a Q
  // without a U (QINTARS), and push a little harder late.
  V4: {
    normalPace: 0.7, maxAggression: 4, minLongReward: 33, volumeA: 12, volumeB: 3.5,
    earlyVolumeMult: 1.0, qNoUFit: 0.6, lateVolumeMult: 1.35,
  },
  // V5: best of B and V3 plus price-aware bidding. V3's higher bids on
  // valuable letters (its 57-60 point words), a word-hold between B's 27 and
  // V3's 33, both versions' rack-need bidding, and bids that follow the
  // room's actual prices (B and V3 both lost pricey rooms with 9-11 tiles
  // and 15-39 coins unspent).
  V5: {
    normalPace: 0.7, maxAggression: 4, minLongReward: 30, volumeA: 12, volumeB: 3.5,
    roomFollow: 1,
  },
};
// Separate word-only variant permits isolating the effect later.
VARIANTS.V6Words = { ...VARIANTS.V3, qualityWords: 1 };
VARIANTS.V6 = {
  ...VARIANTS.V6Words, selectiveSpending: 1, lateVolumeMult: 1.4,
};

// Add or replace versions at runtime (from variants.json), so new
// versions can go live without restarting the bot.
export function mergeVariants(extra: Record<string, Partial<typeof PARAMS>>): void {
  for (const [name, params] of Object.entries(extra)) VARIANTS[name] = params;
}

export function useVariant(name: string): void {
  Object.assign(PARAMS, DEFAULT_PARAMS, VARIANTS[name] ?? {});
}

// Average price paid per tile in ~235 live matches (Nov 2026).
export const MARKET_PRICE: Record<string, number> = {
  A: 10, B: 14, C: 16, D: 13, E: 11, F: 17, G: 12, H: 18, I: 9, J: 24, K: 20, L: 10, M: 15,
  N: 10, O: 10, P: 15, Q: 17, R: 10, S: 12, T: 10, U: 9, V: 15, W: 15, X: 24, Y: 18, Z: 27,
};

const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const A_CODE = 65;

export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const n = word.length;
  if (n <= 3) return base;
  if (n === 4) return Math.floor((base * 3) / 2);
  if (n === 5) return base * 2;
  if (n === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

// ---------- Dictionary index (built once, cached) ----------

export interface DictIndex {
  words: string[]; // sorted by reward, highest first
  rewards: Int32Array;
  lens: Uint8Array;
  masks: Int32Array; // bit i set if the word uses letter i
  counts: Uint8Array; // 26 letter counts per word, flattened
  flex: Float64Array; // per letter: share of 7-8 letter words using it (0..1)
}

let cachedDict: string[] | null = null;
let cachedIndex: DictIndex | null = null;

export function getIndex(dictionary: string[]): DictIndex {
  if (cachedDict === dictionary && cachedIndex) return cachedIndex;
  const clean = dictionary.filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
  const scored = clean.map((w) => ({ w, r: wordReward(w) }));
  scored.sort((a, b) => b.r - a.r || b.w.length - a.w.length);
  const n = scored.length;
  const idx: DictIndex = {
    words: new Array(n),
    rewards: new Int32Array(n),
    lens: new Uint8Array(n),
    masks: new Int32Array(n),
    counts: new Uint8Array(n * 26),
    flex: new Float64Array(26),
  };
  const longUses = new Float64Array(26);
  let longWords = 0;
  for (let i = 0; i < n; i++) {
    const { w, r } = scored[i]!;
    idx.words[i] = w;
    idx.rewards[i] = r;
    idx.lens[i] = w.length;
    let mask = 0;
    for (let j = 0; j < w.length; j++) {
      const s = w.charCodeAt(j) - A_CODE;
      idx.counts[i * 26 + s]!++;
      mask |= 1 << s;
    }
    idx.masks[i] = mask;
    if (w.length === 7 || w.length === 8) {
      longWords++;
      for (let s = 0; s < 26; s++) if (mask & (1 << s)) longUses[s]!++;
    }
  }
  let maxUse = 1;
  for (let s = 0; s < 26; s++) maxUse = Math.max(maxUse, longUses[s]!);
  for (let s = 0; s < 26; s++) idx.flex[s] = longWords ? longUses[s]! / maxUse : 0.5;
  cachedDict = dictionary;
  cachedIndex = idx;
  return idx;
}

interface Rack {
  counts: Int32Array;
  total: number;
  mask: number;
}

function toRack(rack: Map<string, number>): Rack {
  const counts = new Int32Array(26);
  let total = 0;
  let mask = 0;
  for (const [c, n] of rack) {
    const s = c.charCodeAt(0) - A_CODE;
    if (s < 0 || s >= 26 || n <= 0) continue;
    counts[s] += n;
    total += n;
    mask |= 1 << s;
  }
  return { counts, total, mask };
}

// Highest-reward word the rack can spell with at least `minLen` letters,
// or -1. Words are sorted by reward, so the first fit is the best.
function bestWordIndex(idx: DictIndex, rack: Rack, minLen: number): number {
  const { counts, total, mask } = rack;
  const n = idx.words.length;
  outer: for (let i = 0; i < n; i++) {
    const len = idx.lens[i]!;
    if (len < minLen || len > total) continue;
    if (idx.masks[i]! & ~mask) continue;
    const base = i * 26;
    for (let s = 0; s < 26; s++) {
      if (idx.counts[base + s]! > counts[s]!) continue outer;
    }
    return i;
  }
  return -1;
}

// Rack potential with and without one extra letter, in one pass.
// potential = max over words of reward x P(we buy every missing letter).
function potentialPair(
  idx: DictIndex,
  rack: Rack,
  extra: number,
  acquire: Float64Array,
): [number, number] {
  let bestBase = 0;
  let bestPlus = 0;
  const n = idx.words.length;
  const counts = rack.counts;
  for (let i = 0; i < n; i++) {
    const reward = idx.rewards[i]!;
    // Sorted by reward: nothing later can beat what we have.
    if (reward <= bestBase && reward <= bestPlus) break;
    const base = i * 26;
    let pBase = 1;
    let pPlus = 1;
    for (let s = 0; s < 26; s++) {
      const need = idx.counts[base + s]!;
      if (need === 0) continue;
      const have = counts[s]!;
      if (need > have) {
        const q = acquire[s]!;
        const d = need - have;
        pBase *= d === 1 ? q : Math.pow(q, d);
        if (s === extra) {
          if (d > 1) pPlus *= d === 2 ? q : Math.pow(q, d - 1);
        } else {
          pPlus *= d === 1 ? q : Math.pow(q, d);
        }
      }
      if (pBase * reward <= bestBase && pPlus * reward <= bestPlus) break;
    }
    if (pBase * reward > bestBase) bestBase = pBase * reward;
    if (pPlus * reward > bestPlus) bestPlus = pPlus * reward;
  }
  return [bestBase, bestPlus];
}

// Best set of words the rack can still play (endgame value), by depth-first
// search over the highest-scoring playable words. Returns the total points
// and the best single word to play first (-1 if none).
export function planWords(
  idx: DictIndex,
  counts: Int32Array,
  total: number,
  maxWords: number,
): { total: number; first: number; words: number[] } {
  let mask = 0;
  for (let s = 0; s < 26; s++) if (counts[s]! > 0) mask |= 1 << s;
  // Candidate words: everything playable from the full rack, best first.
  const cands: number[] = [];
  const n = idx.words.length;
  outer: for (let i = 0; i < n && cands.length < 400; i++) {
    if (idx.lens[i]! > total || idx.masks[i]! & ~mask) continue;
    const base = i * 26;
    for (let s = 0; s < 26; s++) if (idx.counts[base + s]! > counts[s]!) continue outer;
    cands.push(i);
  }
  let best = 0;
  let bestFirst = -1;
  let bestPath: number[] = [];
  const path: number[] = [];
  let nodes = 0;
  const work = Int32Array.from(counts);
  const rec = (start: number, sum: number, left: number, depth: number, first: number) => {
    if (sum > best) {
      best = sum;
      bestFirst = first;
      bestPath = path.slice();
    }
    if (depth === maxWords || left < 2 || nodes > 60000) return;
    for (let k = start; k < cands.length; k++) {
      const i = cands[k]!;
      const r = idx.rewards[i]!;
      // Sorted by reward: even (maxWords - depth) more of this can't win.
      if (sum + r * (maxWords - depth) <= best) break;
      if (idx.lens[i]! > left) continue;
      const base = i * 26;
      let ok = true;
      for (let s = 0; s < 26; s++) {
        if (idx.counts[base + s]! > work[s]!) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      nodes++;
      for (let s = 0; s < 26; s++) work[s] -= idx.counts[base + s]!;
      path.push(i);
      rec(k, sum + r, left - idx.lens[i]!, depth + 1, first < 0 ? i : first);
      path.pop();
      for (let s = 0; s < 26; s++) work[s] += idx.counts[base + s]!;
    }
  };
  rec(0, 0, total, 0, -1);
  return { total: best, first: bestFirst, words: bestPath };
}

/**
 * Endgame: the full set of words to play right now (they use disjoint
 * letters), or [] if it isn't the endgame yet. Submitting them all at once
 * beats playing one word per rack update when only seconds are left.
 */
export function endgameWords(ctx: WordContext): string[] {
  if (ctx.remainingAuctions === undefined || ctx.remainingAuctions > PARAMS.endgameAuctions) {
    return [];
  }
  const idx = getIndex(ctx.dictionary);
  const rack = toRack(ctx.myRack);
  if (rack.total < 2) return [];
  return planWords(idx, rack.counts, rack.total, PARAMS.maxPlanWords).words.map((i) => idx.words[i]!);
}

// Chance we eventually buy each letter, from how many are still unseen and
// how many auctions are left.
function acquireOdds(
  unseen: Map<string, number> | undefined,
  remainingAuctions: number,
): Float64Array {
  const out = new Float64Array(26);
  let unseenTotal = 0;
  const u = new Float64Array(26);
  for (let s = 0; s < 26; s++) {
    const c = String.fromCharCode(A_CODE + s);
    u[s] = unseen ? Math.max(0, unseen.get(c) ?? 0) : BAG_COUNTS[c] ?? 0;
    unseenTotal += u[s]!;
  }
  if (unseenTotal <= 0) return out;
  for (let s = 0; s < 26; s++) {
    const appearances = (u[s]! * remainingAuctions) / unseenTotal;
    out[s] = Math.min(
      PARAMS.maxAcquire,
      1 - Math.exp(-appearances * PARAMS.winRate),
    );
  }
  return out;
}

// ---------- Bidding ----------

export interface BidContext {
  letter: string; // Letter being auctioned, e.g. "Q"
  myBalance: number; // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
  // Optional extras (the bot fills these in; tests may leave them out).
  dictionary?: string[];
  remainingAuctions?: number; // auctions AFTER this one (0 = this is the last)
  auctionType?: "Vickrey" | "FirstPrice";
  unseen?: Map<string, number>; // letters not yet seen in this match
  maxOpponentBalance?: number;
  // How expensive this room is: average (price paid / usual price) of
  // recent auctions in this match. 1 = normal.
  roomPriceRatio?: number;
}

// Value of the letter to us, in points.
export function letterValue(ctx: BidContext): number {
  const L = ctx.letter;
  const s = L.charCodeAt(0) - A_CODE;
  const face = LETTER_VALUE[L] ?? 1;
  const have = ctx.myRack.get(L) ?? 0;
  const remaining = ctx.remainingAuctions ?? 40;

  if (!ctx.dictionary || ctx.dictionary.length === 0) {
    // Fallback without a dictionary: favour common letters, avoid duplicates.
    return (face + 2) * Math.pow(0.5, have);
  }
  const idx = getIndex(ctx.dictionary);
  const rack = toRack(ctx.myRack);
  const acquire = acquireOdds(ctx.unseen, remaining);
  const [before, after] = potentialPair(idx, rack, s, acquire);
  let value = Math.max(0, after - before);

  // Flexibility: common letters in long words keep options open. Fades as
  // the match runs out, and for duplicates we already hold.
  // (Q without a U gets little: its real uses are already in the potential.)
  const timeLeft = Math.min(1, remaining / 40);
  const qPenalty = L === "Q" && (ctx.myRack.get("U") ?? 0) === 0 ? 0.3 : 1;
  value += PARAMS.flexBonus * idx.flex[s]! * timeLeft * Math.pow(0.5, have) * qPenalty;

  // Vowel balance: long words need roughly 35-45% vowels.
  let vowels = 0;
  let total = 0;
  for (const [c, n] of ctx.myRack) {
    total += n;
    if (VOWELS.has(c)) vowels += n;
  }
  if (total >= 3) {
    const ratio = vowels / total;
    if (VOWELS.has(L)) {
      if (ratio < 0.25) value *= 1.3;
      else if (ratio > 0.55) value *= 0.6;
    } else {
      if (ratio > 0.55) value *= 1.2;
      else if (ratio < 0.2) value *= 0.7;
    }
  }
  return value;
}

// How well a letter fits the rack for volume buying (0.3 .. 1): penalise
// duplicates, the wrong side of the vowel balance, and Q without U.
export function rackFit(ctx: BidContext): number {
  const L = ctx.letter;
  const have = ctx.myRack.get(L) ?? 0;
  let fit = have === 0 ? 1 : have === 1 ? 0.85 : have === 2 ? 0.55 : 0.3;
  let vowels = 0;
  let total = 0;
  for (const [c, n] of ctx.myRack) {
    total += n;
    if (VOWELS.has(c)) vowels += n;
  }
  if (total >= 4) {
    const ratio = vowels / total;
    if (VOWELS.has(L) && ratio > PARAMS.vowelCap) fit *= 0.6;
    if (!VOWELS.has(L) && ratio < 0.25) fit *= 0.7;
  }
  if (L === "Q" && (ctx.myRack.get("U") ?? 0) === 0) fit *= PARAMS.qNoUFit;
  return Math.max(0.3, fit);
}

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 */
export function decideBid(ctx: BidContext): number {
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  if (balance <= 0) return 0;
  const remaining = ctx.remainingAuctions;
  // The match ends the instant the last auction closes: that tile can
  // never be played.
  if (remaining !== undefined && remaining <= 0) return 0;

  let value = letterValue(ctx);

  // Endgame: value the tile exactly — how many points it adds to the best
  // set of words we can still play before the match ends. This is what
  // rescues leftover letters that would otherwise be wasted.
  let endBid = 0;
  if (
    remaining !== undefined &&
    remaining <= PARAMS.exactWindow &&
    ctx.dictionary &&
    ctx.dictionary.length > 0
  ) {
    const idx = getIndex(ctx.dictionary);
    const rack = toRack(ctx.myRack);
    const before = planWords(idx, rack.counts, rack.total, PARAMS.maxPlanWords).total;
    const s = ctx.letter.charCodeAt(0) - A_CODE;
    rack.counts[s]!++;
    const after = planWords(idx, rack.counts, rack.total + 1, PARAMS.maxPlanWords).total;
    let gain = Math.max(0, after - before);
    if (remaining === 1) gain *= PARAMS.lastPlayableDiscount;
    value = Math.max(value, gain);
    endBid = Math.round(gain * PARAMS.endCoinPerPoint);
  }
  if (value < 0.5) return 0;

  // Coins are only worth what they buy. Spend faster when we're flush
  // relative to the auctions left — counting coins future words will
  // bring back, not just the ones we hold now.
  const budget = balance + PARAMS.incomeRate * (remaining ?? 40);
  const pace = budget / Math.max(1, (remaining ?? 40) + 1);
  const aggression = Math.min(
    PARAMS.maxAggression,
    Math.max(PARAMS.minAggression, pace / PARAMS.normalPace),
  );
  // Room price level (1 = normal market): in a pricey room every bid —
  // word-completing, volume and late — rises with the going rate.
  const roomMult = Math.pow(
    Math.min(1.7, Math.max(0.8, ctx.roomPriceRatio ?? 1)),
    PARAMS.roomFollow,
  );
  let bid = Math.round(value * aggression * roomMult);

  // Volume baseline (top-bot style): a steady bid on every usable tile, so
  // we keep a big, flexible rack. The value-based bid above still wins when
  // a tile completes a word.
  const rem = remaining ?? 40;
  if (PARAMS.volumeB > 0 && rem > PARAMS.endgameAuctions) {
    const face = LETTER_VALUE[ctx.letter] ?? 1;
    const pace = budget / Math.max(1, (rem + 1) * PARAMS.volumeCost);
    const phaseMult =
      rem > 45 ? PARAMS.earlyVolumeMult : rem < 23 ? PARAMS.lateVolumeMult : 1;
    const volume =
      (PARAMS.volumeA + PARAMS.volumeB * face) *
      phaseMult *
      roomMult *
      rackFit(ctx) *
      Math.min(1.3, Math.max(0.3, pace));
    bid = Math.max(bid, Math.round(volume));
  }

  // Use it or lose it: late in the match, spare coins are worth nothing,
  // so bid up to the going price on any letter we can actually use.
  if (
    remaining !== undefined &&
    remaining <= PARAMS.lateWindow &&
    value >= PARAMS.lateMinValue
  ) {
    const glut = balance / Math.max(1, remaining * PARAMS.lateSpendRate);
    const usual = (MARKET_PRICE[ctx.letter] ?? 12) * roomMult;
    const floor = Math.round(usual * Math.min(PARAMS.lateMaxMarket, glut));
    bid = Math.max(bid, floor);
  }
  bid = Math.max(bid, endBid);

  // Reserve cash on speculative purchases across ALL bid components.
  // A valuable immediate completion can use the reserve. Release it in
  // the last third; the exact endgame calculation is never discounted.
  if (PARAMS.selectiveSpending > 0 && rem >= 23) {
    let completes = false;
    if (ctx.dictionary?.length) {
      const idx = getIndex(ctx.dictionary);
      const rack = toRack(ctx.myRack);
      const before = bestWordIndex(idx, rack, 5);
      const counts = Int32Array.from(rack.counts);
      const letter = ctx.letter.charCodeAt(0) - A_CODE;
      counts[letter]!++;
      const after = bestWordIndex(idx, {
        counts, total: rack.total + 1, mask: rack.mask | (1 << letter),
      }, 5);
      const reward = after >= 0 ? idx.rewards[after]! : 0;
      const gain = reward - (before >= 0 ? idx.rewards[before]! : 0);
      completes = reward >= PARAMS.qualityCashMin && gain >= PARAMS.completionMinGain;
    }
    if (!completes) {
      const discount = rem > 45 ? PARAMS.speculativeEarlyMult : PARAMS.speculativeMidMult;
      bid = Math.min(Math.round(bid * discount), Math.max(0, balance - PARAMS.purchaseReserve));
    }
  }

  if (ctx.auctionType === "FirstPrice") {
    // We pay our own bid: shade it to a bit above what tiles usually sell
    // for, instead of paying our full value.
    const usual = MARKET_PRICE[ctx.letter] ?? 12;
    bid = Math.min(bid, Math.round(usual * PARAMS.firstPriceShade));
  }
  if (ctx.maxOpponentBalance !== undefined) {
    // Nobody can outbid what they can't afford.
    bid = Math.min(bid, ctx.maxOpponentBalance + 1);
  }
  return Math.max(0, Math.min(bid, balance));
}

// ---------- Word play ----------

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Uppercase list, shared at startup
  remainingAuctions?: number; // auctions after the current one
  myBalance?: number;
}

/**
 * Pick a word to play now, or null to keep hoarding.
 *  - 7+ letters (3x): play it right away.
 *  - Endgame: play the best word of any length, repeatedly, to empty the rack.
 *  - Broke: cash a 5+ letter word so we can keep bidding.
 */
export function chooseWord(ctx: WordContext): string | null {
  const idx = getIndex(ctx.dictionary);
  const rack = toRack(ctx.myRack);
  if (rack.total < 2) return null;

  const endgame =
    ctx.remainingAuctions !== undefined &&
    ctx.remainingAuctions <= PARAMS.endgameAuctions;
  if (endgame) {
    // Play the first word of the best SET of words, so leftovers still score.
    const plan = planWords(idx, rack.counts, rack.total, PARAMS.maxPlanWords);
    return plan.first >= 0 ? idx.words[plan.first]! : null;
  }

  if (PARAMS.qualityWords > 0) {
    // Compare up to six high-reward choices, including valuable 5/6s.
    // Reward the words still playable from the leftover letters too.
    const remaining = ctx.remainingAuctions ?? 40;
    const canWait = remaining >= 23 && (ctx.myBalance ?? 0) >= PARAMS.qualityCashBalance;
    const future = canWait ? potentialPair(idx, rack, -1, acquireOdds(undefined, remaining))[0] : 0;
    let best = -1, bestScore = -1, considered = 0;
    outer: for (let i = 0; i < idx.words.length && considered < 6; i++) {
      const len = idx.lens[i]!, reward = idx.rewards[i]!;
      if (len < 5 || len > rack.total || (idx.masks[i]! & ~rack.mask)) continue;
      if (len < 7 && reward < PARAMS.qualityCashMin) continue;
      if (len >= 7 && reward < PARAMS.minLongReward && remaining >= 23 && rack.total < 11) continue;
      const base = i * 26;
      for (let c = 0; c < 26; c++) if (idx.counts[base + c]! > rack.counts[c]!) continue outer;
      considered++;
      if (len < 7 && canWait && future > reward * 1.35) continue;
      const left = Int32Array.from(rack.counts);
      let mask = 0;
      for (let c = 0; c < 26; c++) {
        left[c] -= idx.counts[base + c]!;
        if (left[c]! > 0) mask |= 1 << c;
      }
      const next = bestWordIndex(idx, { counts: left, total: rack.total - len, mask }, 2);
      const score = reward + 0.35 * (next >= 0 ? idx.rewards[next]! : 0);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (best >= 0) return idx.words[best]!;
    // Retain the existing emergency-cash and endgame behavior below.
  }

  let long = rack.total >= 7 ? bestWordIndex(idx, rack, 7) : -1;
  // Hold a weak long word for a better one while there's time, unless the
  // rack is getting big.
  if (
    long >= 0 &&
    PARAMS.minLongReward > 0 &&
    idx.rewards[long]! < PARAMS.minLongReward &&
    (ctx.remainingAuctions ?? 0) >= 23 &&
    rack.total < 11
  ) {
    long = -1;
  }
  if (long >= 0) {
    if (PARAMS.leaveWeight <= 0) return idx.words[long]!;
    // Among the playable 7+ words, keep the leftover letters most promising.
    const acquire = acquireOdds(undefined, ctx.remainingAuctions ?? 40);
    let bestScore = -1;
    let bestI = long;
    let seen = 0;
    const n = idx.words.length;
    outer: for (let i = long; i < n && seen < 12; i++) {
      if (idx.lens[i]! < 7 || idx.lens[i]! > rack.total) continue;
      if (idx.masks[i]! & ~rack.mask) continue;
      const base = i * 26;
      for (let s = 0; s < 26; s++) if (idx.counts[base + s]! > rack.counts[s]!) continue outer;
      seen++;
      const left = Int32Array.from(rack.counts);
      let leftMask = 0;
      for (let s = 0; s < 26; s++) {
        left[s] -= idx.counts[base + s]!;
        if (left[s]! > 0) leftMask |= 1 << s;
      }
      const leave = potentialPair(
        idx,
        { counts: left, total: rack.total - idx.lens[i]!, mask: leftMask },
        -1,
        acquire,
      )[0];
      const score = idx.rewards[i]! + PARAMS.leaveWeight * leave;
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    return idx.words[bestI]!;
  }

  if (PARAMS.midCashMin > 0 && rack.total >= 5) {
    const mid = bestWordIndex(idx, rack, 5);
    if (mid >= 0 && idx.rewards[mid]! >= PARAMS.midCashMin) return idx.words[mid]!;
  }

  if (rack.total >= PARAMS.bigRack) {
    const six = bestWordIndex(idx, rack, 6);
    if (six >= 0) return idx.words[six]!;
  }

  if (ctx.myBalance !== undefined && ctx.myBalance < PARAMS.brokeBalance && rack.total >= 5) {
    const mid = bestWordIndex(idx, rack, 5);
    if (mid >= 0) return idx.words[mid]!;
  }
  return null;
}
