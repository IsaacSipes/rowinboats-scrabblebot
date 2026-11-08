// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAG_COUNTS,
  chooseWord,
  decideBid,
  endgameWords,
  getIndex,
  MARKET_PRICE,
  mergeVariants,
  useVariant,
} from "./strategy.js";

// Seconds to wait after a match before rejoining the lobby, read from
// lobby-delay.txt (milliseconds) so it can be tuned live. Rejoining instantly
// lands us in a lobby with the same bots that also rejoin instantly.
function lobbyDelayMs(): number {
  try {
    const v = Number(fs.readFileSync(path.join(process.cwd(), "lobby-delay.txt"), "utf8").trim());
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch {
    return Number(process.env.LOBBY_DELAY_MS ?? 0) || 0;
  }
}

// ---- A/B test: alternate strategy versions match by match (AB_TEST=1) ----
const AB = process.env.AB_TEST === "1";
// Versions to rotate through, one per match (e.g. AB_VARIANTS=A,B,V3).
const ROTATION = (process.env.AB_VARIANTS ?? "A,B").split(",").map((s) => s.trim()).filter(Boolean);
const AB_LOG = path.join(process.cwd(), "ab-log.tsv");
const matchVariant = new Map<string, string>();
try {
  for (const line of fs.readFileSync(AB_LOG, "utf8").split("\n")) {
    const [m, v] = line.split("\t");
    if (m && v) matchVariant.set(m, v);
  }
} catch {
  // no log yet
}
function variantFor(matchId: bigint): string {
  const key = String(matchId);
  const known = matchVariant.get(key);
  if (known) return known;
  // New match: pick up any versions added in variants.json.
  try {
    mergeVariants(JSON.parse(fs.readFileSync(path.join(process.cwd(), "variants.json"), "utf8")));
  } catch {
    // no file or bad JSON: keep the built-in versions
  }
  // The rotation can be changed live by editing ab-rotation.txt (e.g.
  // "B,V3,V5"); otherwise AB_VARIANTS from the environment.
  let rotation = ROTATION;
  try {
    const fromFile = fs
      .readFileSync(path.join(process.cwd(), "ab-rotation.txt"), "utf8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromFile.length > 0) rotation = fromFile;
  } catch {
    // no file: use the environment
  }
  const v = AB ? rotation[matchVariant.size % rotation.length]! : "A";
  matchVariant.set(key, v);
  if (AB) {
    fs.appendFileSync(AB_LOG, `${key}\t${v}\t${new Date().toISOString()}\n`);
    console.log(`[${BOT_NAME}] match ${key}: playing version ${v}`);
  }
  return v;
}

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
// fileURLToPath (not URL.pathname) so Windows paths with spaces work.
const dictionaryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
if (DICTIONARY.length === 0) {
  console.error(`[${BOT_NAME}] wordlist not found at ${dictionaryPath}`);
  process.exit(1);
}
getIndex(DICTIONARY); // build the word index now, not during the first auction
console.log(`[${BOT_NAME}] loaded ${DICTIONARY.length} words`);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
// Throttle retries of the same word (a failing call), not new words.
const lastWordAttempt = new Map<string, number>();
// Our rack updates arrive ~0.5 s after a play, so wait before retrying the
// same word (it has usually already gone through).
const WORD_RETRY_MS = 2500;

// Rows of `table` for one match, via the client-side index when the SDK
// offers one, otherwise a scan.
function rowsForMatch<R extends { matchId: bigint }>(
  table: { iter(): Iterable<R> },
  indexName: string,
  matchId: bigint,
): R[] {
  const index = (table as unknown as Record<string, unknown>)[indexName] as
    | { filter?: (k: bigint) => Iterable<R> }
    | undefined;
  if (index && typeof index.filter === "function") {
    try {
      return Array.from(index.filter(matchId));
    } catch {
      // fall through to a scan
    }
  }
  const out: R[] = [];
  for (const r of table.iter()) if (r.matchId === matchId) out.push(r);
  return out;
}

interface MatchInfo {
  remainingAuctions: number; // auctions after the current one
  auctionType: "Vickrey" | "FirstPrice";
  unseen: Map<string, number>; // letters not yet seen by us
  maxOpponentBalance: number | undefined;
  roomPriceRatio: number | undefined;
}

// Everything public about a match that helps value a letter.
function matchInfo(conn: DbConnection, matchId: bigint): MatchInfo | null {
  const m = conn.db.matchState.id.find(matchId);
  if (!m) return null;
  const auctionType = m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey";

  const seen = new Map<string, number>();
  const add = (map: Map<string, number>, c: string, n = 1) =>
    map.set(c, (map.get(c) ?? 0) + n);

  // Every auctioned letter (won or not), plus the one open now.
  const wonBy = new Map<string, Map<string, number>>(); // botId -> letters
  const results = rowsForMatch(conn.db.auctionResult, "resultByMatch", matchId);
  // Room price level: recent prices relative to the usual market price
  // (ignore reserve-price and no-bid auctions).
  const recent = [...results]
    .filter((r) => Number(r.paid) >= 3)
    .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
    .slice(-20);
  const roomPriceRatio =
    recent.length >= 5
      ? recent.reduce((s, r) => s + Number(r.paid) / (MARKET_PRICE[r.letter] ?? 12), 0) /
        recent.length
      : undefined;
  for (const r of results) {
    add(seen, r.letter);
    if (r.winnerBotId !== undefined && r.winnerBotId !== null) {
      const k = String(r.winnerBotId);
      if (!wonBy.has(k)) wonBy.set(k, new Map());
      add(wonBy.get(k)!, r.letter);
    }
  }
  for (const a of rowsForMatch(conn.db.auction, "auctionByMatch", matchId)) {
    if (a.status.tag === "Open") add(seen, a.letter);
  }

  // Starting tiles revealed by word plays: letters played beyond those won.
  const playedBy = new Map<string, Map<string, number>>();
  for (const w of rowsForMatch(conn.db.wordPlay, "playByMatch", matchId)) {
    const k = String(w.botId);
    if (!playedBy.has(k)) playedBy.set(k, new Map());
    for (const c of w.word) add(playedBy.get(k)!, c);
  }
  const myKey = String(myBotId);
  const rack = rackForMatch(conn, matchId);
  const bots = new Set([...playedBy.keys(), myKey]);
  for (const k of bots) {
    const played = playedBy.get(k) ?? new Map<string, number>();
    const won = wonBy.get(k) ?? new Map<string, number>();
    const letters = new Set([...played.keys(), ...(k === myKey ? rack.keys() : [])]);
    for (const c of letters) {
      const held = k === myKey ? rack.get(c) ?? 0 : 0;
      const start = held + (played.get(c) ?? 0) - (won.get(c) ?? 0);
      if (start > 0) add(seen, c, start);
    }
  }
  const unseen = new Map<string, number>();
  for (const [c, n] of Object.entries(BAG_COUNTS)) {
    unseen.set(c, Math.max(0, n - (seen.get(c) ?? 0)));
  }

  // Only cap by opponents' coins once their rows have arrived: in the first
  // seconds of a match they haven't, and a cap of "0 + 1" made us bid 1.
  let maxOpponentBalance: number | undefined;
  for (const p of rowsForMatch(conn.db.matchParticipant, "mpByMatch", matchId)) {
    if (p.botId === myBotId) continue;
    maxOpponentBalance = Math.max(maxOpponentBalance ?? 0, Number(p.balance));
  }
  return { remainingAuctions: m.bagTotal, auctionType, unseen, maxOpponentBalance, roomPriceRatio };
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

// Letters in words we've submitted but the server hasn't confirmed yet
// (~0.5 s). Subtracting them stops us planning or bidding with letters
// that are already spent.
const pendingSpend: { matchId: bigint; word: string; at: number }[] = [];
const PENDING_MS = 3000;

function clearPending(matchId: bigint, word: string) {
  const i = pendingSpend.findIndex((p) => p.matchId === matchId && p.word === word);
  if (i >= 0) pendingSpend.splice(i, 1);
}

function effectiveRack(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = rackForMatch(conn, matchId);
  const now = Date.now();
  for (let i = pendingSpend.length - 1; i >= 0; i--) {
    const p = pendingSpend[i]!;
    if (now - p.at > PENDING_MS) {
      pendingSpend.splice(i, 1);
      continue;
    }
    if (p.matchId !== matchId) continue;
    for (const c of p.word) {
      const left = (rack.get(c) ?? 0) - 1;
      if (left > 0) rack.set(c, left);
      else rack.delete(c);
    }
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  // How long after the auction opened (server clock) we heard about it.
  const opened = conn.db.auction.id.find(auctionId)?.opensAt;
  const heardAfter = opened
    ? Date.now() - Number(opened.microsSinceUnixEpoch / 1000n)
    : NaN;
  const started = performance.now();
  useVariant(variantFor(matchId));
  const info = matchInfo(conn, matchId);
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: effectiveRack(conn, matchId),
    dictionary: DICTIONARY,
    remainingAuctions: info?.remainingAuctions,
    auctionType: info?.auctionType,
    unseen: info?.unseen,
    maxOpponentBalance: info?.maxOpponentBalance,
    roomPriceRatio: info?.roomPriceRatio,
  });
  const took = performance.now() - started;
  if (took > 200) console.warn(`[${BOT_NAME}] slow bid decision: ${took.toFixed(0)} ms`);
  if (amount <= 0) {
    bidsByAuction.add(key);
    return;
  }
  const sentAt = performance.now();
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch((err: unknown) =>
      console.warn(
        `[${BOT_NAME}] bid on auction ${auctionId} failed after ${(performance.now() - sentAt).toFixed(0)} ms round trip: ${err instanceof Error ? err.message : err}`,
      ),
    );
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId}; heard ${heardAfter.toFixed(0)} ms after open, decided in ${took.toFixed(0)} ms)`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const m = conn.db.matchState.id.find(matchId);
    useVariant(variantFor(matchId));
    const ctx = {
      myRack: effectiveRack(conn, matchId),
      dictionary: DICTIONARY,
      remainingAuctions: m?.bagTotal,
      myBalance: participantForMatch(conn, matchId)?.balance,
    };
    // Endgame: submit the whole planned set of words at once — waiting for a
    // rack update between words can run out the clock.
    let words = endgameWords(ctx);
    if (words.length === 0) {
      const w = chooseWord(ctx);
      if (w) words = [w];
    }
    for (const word of words) {
      const key = `${matchId}:${word}`;
      if (now - (lastWordAttempt.get(key) ?? 0) < WORD_RETRY_MS) continue;
      lastWordAttempt.set(key, now);
      pendingSpend.push({ matchId, word, at: now });
      console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
      conn.reducers.submitWord({ matchId, word }).catch((err: unknown) => {
        clearPending(matchId, word);
        logFailure(`playing '${word}'`)(err);
      });
    }
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    // Only small tables here. Full history tables (156k lobby members, 26k
    // lobbies and matches, 1.8M auctions) made the server push us so much
    // that our bids queued for seconds and missed their auctions.
    .subscribe([
      "SELECT * FROM bot_credential",
      "SELECT * FROM bot",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
      "SELECT * FROM my_rack",
      "SELECT * FROM tournament",
    ]);

  // Sign up for any tournament that opens for registration (AUTO_TOURNAMENT=0
  // turns this off). Only the bot's own process can register it.
  const autoRegister = (tournamentId: bigint, statusTag: string) => {
    if (process.env.AUTO_TOURNAMENT === "0") return;
    if (myBotId === null || statusTag !== "Registration") return;
    const key = String(tournamentId);
    if (registeredTournaments.has(key)) return;
    registeredTournaments.add(key);
    conn.reducers
      .registerForTournament({ tournamentId })
      .then(() => console.log(`[${BOT_NAME}] registered for tournament ${tournamentId}`))
      .catch(logFailure(`registering for tournament ${tournamentId}`));
  };
  conn.db.tournament.onInsert((_ctx, t) => autoRegister(t.id, t.status.tag));
  conn.db.tournament.onUpdate((_ctx, _old, t) => autoRegister(t.id, t.status.tag));
  autoRegisterAll = () => {
    for (const t of conn.db.tournament.iter()) autoRegister(t.id, t.status.tag);
  };

  // Per-match data arrives only for matches we're in. (Ignore the initial
  // load of our past participations: those matches are over.)
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (participationsLoaded && myBotId !== null && p.botId === myBotId) {
      subscribeMatch(conn, p.matchId);
    }
  });

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    // Only live auctions (the initial load includes our past matches').
    if (a.status.tag !== "Open") return;
    if (participantForMatch(conn, a.matchId) === null) return;
    tryBid(conn, a.id, a.matchId, a.letter);
    // Each new auction moves the clock: the endgame dump keys off it.
    tryPlayWord(conn);
  });
  // A confirmed word: its letters are now gone from our rack row too.
  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (myBotId !== null && w.botId === myBotId) {
      clearPending(w.matchId, w.word);
      console.log(`[${BOT_NAME}] match ${w.matchId}: '${w.word}' scored ${w.totalReward}`);
    }
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const won = r.winnerBotId === myBotId;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} '${r.letter}' → ${won ? "WE WON, paid" : `bot ${winner} paid`} ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        const me = participantForMatch(conn, neu.id);
        console.log(
          `[${BOT_NAME}] match ${neu.id} ended: score ${me?.score ?? "?"}, ${me?.balance ?? "?"} coins left; rejoining lobby`,
        );
        // Drop the finished match's data after a moment.
        setTimeout(() => unsubscribeMatch(neu.id), 5000);
        const delay = lobbyDelayMs();
        if (delay > 0) {
          console.log(`[${BOT_NAME}] waiting ${(delay / 1000).toFixed(0)} s before rejoining (different lobby)`);
          setTimeout(() => joinLobby(conn), delay);
        } else {
          joinLobby(conn);
        }
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.openLobbies.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.openLobbyMembers.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

// ---- Tournaments ----
const registeredTournaments = new Set<string>();
let autoRegisterAll: () => void = () => {};

// ---- Per-match subscriptions ----
const matchSubs = new Map<string, { unsubscribe(): void }>();
let participationsLoaded = false;

function subscribeMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (matchSubs.has(key)) return;
  const m = conn.db.matchState.id.find(matchId);
  if (m && m.status.tag === "Ended") return;
  const handle = conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] following match ${matchId}`);
      for (const a of conn.db.auction.iter()) {
        if (a.matchId === matchId && a.status.tag === "Open") {
          tryBid(conn, a.id, a.matchId, a.letter);
        }
      }
      tryPlayWord(conn);
    })
    .subscribe([
      // (Our auctions and match rows come from the join subscriptions.)
      `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
      `SELECT * FROM word_play WHERE match_id = ${matchId}`,
      `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
    ]);
  matchSubs.set(key, handle);
}

function unsubscribeMatch(matchId: bigint) {
  const key = String(matchId);
  const h = matchSubs.get(key);
  if (!h) return;
  matchSubs.delete(key);
  try {
    h.unsubscribe();
  } catch {
    // already gone
  }
}

function bootstrapActivity(conn: DbConnection) {
  // Our participations, plus the match rows and auctions of ONLY the matches
  // we're in. The join delivers a new match's first auction in the same
  // update that seats us, so we can bid on it right away.
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      participationsLoaded = true;
      for (const p of conn.db.matchParticipant.iter()) {
        if (p.botId !== myBotId) continue;
        const m = conn.db.matchState.id.find(p.matchId);
        if (m && m.status.tag === "Running") subscribeMatch(conn, p.matchId);
      }
      for (const a of conn.db.auction.iter()) {
        if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
      }
      joinLobby(conn);
      tryPlayWord(conn);
    })
    .onError((ctx: ErrorContext) =>
      console.error(`[${BOT_NAME}] match subscription failed: ${String((ctx as { event?: unknown }).event ?? "")}`),
    )
    .subscribe([
      `SELECT * FROM match_participant WHERE bot_id = ${myBotId}`,
      `SELECT match_state.* FROM match_state JOIN match_participant ON match_state.id = match_participant.match_id WHERE match_participant.bot_id = ${myBotId}`,
      `SELECT auction.* FROM auction JOIN match_participant ON auction.match_id = match_participant.match_id WHERE match_participant.bot_id = ${myBotId}`,
    ]);

  autoRegisterAll();
  if (TOURNAMENT_ID) {
    registeredTournaments.add(TOURNAMENT_ID);
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
