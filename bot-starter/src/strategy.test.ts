// Checks for the strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid, endgameWords, getIndex, useVariant, wordReward } from "./strategy.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

const WORDS = fs
  .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2);

test("holds short words mid-match, plays 7+ letter words at once", () => {
  const dictionary = ["TACT", "CAT", "AT", "CATTIER"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary, remainingAuctions: 30 }), null);
  assert.equal(
    chooseWord({ myRack: rack("CATTIERX"), dictionary, remainingAuctions: 30 }),
    "CATTIER",
  );
});

test("dumps the best word of any length in the endgame", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary, remainingAuctions: 1 }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CATX"), dictionary, remainingAuctions: 0 }), "CAT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary, remainingAuctions: 0 }), null);
});

test("never bids on the last tile, never bids more than the balance", () => {
  const base = { myRack: rack("RETAIN"), dictionary: WORDS };
  assert.equal(decideBid({ ...base, letter: "S", myBalance: 50, remainingAuctions: 0 }), 0);
  const bid = decideBid({ ...base, letter: "S", myBalance: 3, remainingAuctions: 2 });
  assert.ok(bid >= 0 && bid <= 3);
});

test("values a letter that completes a long word above a dud", () => {
  const base = { myRack: rack("RETAIN"), dictionary: WORDS, myBalance: 100, remainingAuctions: 30 };
  const s = decideBid({ ...base, letter: "S" }); // RETAINS / NASTIER: 21 pts
  const q = decideBid({ ...base, letter: "Q" }); // QINTAR: 37 pts
  const z = decideBid({ ...base, myRack: rack("EEIIOO"), letter: "Q" }); // only QI
  assert.ok(s >= 5, `S bid ${s} should be solid`);
  assert.ok(q > s, `Q bid ${q} should beat S bid ${s} (QINTAR)`);
  assert.ok(z < 23, `Q with no U and no long word (${z}) should go below its ~23 usual price`);
});

test("volume buying: bids near the going price, less for duplicates", () => {
  const base = { dictionary: WORDS, myBalance: 100, remainingAuctions: 60, letter: "T" };
  const fresh = decideBid({ ...base, myRack: rack("AEIRS") });
  const third = decideBid({ ...base, myRack: rack("AEITT") });
  assert.ok(fresh >= 8 && fresh <= 25, `T bid ${fresh} should be near the ~9-12 going price`);
  assert.ok(third < fresh, `third T (${third}) should be bid below a first T (${fresh})`);
});

test("endgame plans a set of words from the leftovers, only in the endgame", () => {
  const words = endgameWords({ myRack: rack("CATDOG"), dictionary: WORDS, remainingAuctions: 1 });
  const used = rack(words.join(""));
  for (const [c, n] of used) assert.ok(n <= (rack("CATDOG").get(c) ?? 0), `plan ${words} overuses ${c}`);
  const total = words.reduce((s, w) => s + wordReward(w), 0);
  assert.ok(total >= 10, `plan ${words} scores ${total}, CAT + DOG alone is 10`);
  assert.deepEqual(endgameWords({ myRack: rack("CATDOG"), dictionary: WORDS, remainingAuctions: 30 }), []);
});

test("endgame bids for a tile that rescues leftover letters", () => {
  // Holding Q-I-Z-A-R-D minus one letter: the missing D turns leftovers into a big word.
  const base = { dictionary: WORDS, myBalance: 60, remainingAuctions: 2, myRack: rack("QIZAR") };
  const d = decideBid({ ...base, letter: "D" });
  assert.ok(d >= 15, `D completes a big word late; bid ${d} should be high`);
});

test("price-aware bidding bids up in an expensive room (V5)", () => {
  useVariant("V5");
  const base = { dictionary: WORDS, myBalance: 100, remainingAuctions: 50, letter: "T", myRack: rack("AEIRS") };
  const normal = decideBid({ ...base, roomPriceRatio: 1 });
  const pricey = decideBid({ ...base, roomPriceRatio: 1.5 });
  useVariant("A");
  assert.ok(pricey > normal, `pricey room bid ${pricey} should beat normal room bid ${normal}`);
});

// A bid has to land inside a 1-second auction.
test("V6 compares valuable short words and cashes them before the endgame", () => {
  useVariant("V6");
  try {
    for (const [letters, expected] of [["QUARTERZ", "QUARTZ"], ["EXOGEN", "EXOGEN"], ["FRITZ", "FRITZ"]]) {
      assert.equal(chooseWord({ myRack: rack(letters!), dictionary: WORDS, myBalance: 20, remainingAuctions: 30 }), expected);
    }
    assert.equal(chooseWord({ myRack: rack("CAT"), dictionary: WORDS, myBalance: 20, remainingAuctions: 30 }), null);
  } finally { useVariant("A"); }
});

test("V6 preserves cash on speculation but exempts valuable completions", () => {
  const base = {dictionary: ["QUARTZ", "QUARTER", "CAT"], myBalance: 30, remainingAuctions: 35};
  useVariant("V3");
  const before = decideBid({...base, myRack: rack("QUART"), letter: "Z"});
  useVariant("V6");
  try {
    assert.equal(decideBid({...base, myRack: rack("QUART"), letter: "Z"}), before);
    assert.ok(decideBid({...base, myRack: rack("CA"), letter: "T"}) <= 5);
    assert.equal(decideBid({...base, myRack: rack("CA"), letter: "T", myBalance: 25}), 0);
    assert.ok(decideBid({...base, myRack: rack("CA"), letter: "T", remainingAuctions: 10}) > 5);
    assert.equal(decideBid({...base, myRack: rack("QUART"), letter: "Z", remainingAuctions: 0}), 0);
  } finally { useVariant("A"); }
});

test("switching back to V3 restores its original word policy", () => {
  useVariant("V6");
  useVariant("V3");
  try {
    assert.equal(chooseWord({myRack: rack("FRITZ"), dictionary: WORDS, myBalance: 20, remainingAuctions: 30}), null);
  } finally { useVariant("A"); }
});

test("V6 decision latency stays below the auction budget", () => {
  useVariant("V6");
  try {
    getIndex(WORDS);
    const start = performance.now();
    decideBid({letter: "Z", myRack: rack("QUARTER"), dictionary: WORDS, myBalance: 60, remainingAuctions: 40});
    chooseWord({myRack: rack("QUARTERZAEINST"), dictionary: WORDS, myBalance: 60, remainingAuctions: 40});
    assert.ok(performance.now() - start < 150, "V6 decisions exceeded 150 ms");
  } finally { useVariant("A"); }
});

test("decisions are fast on the full wordlist", () => {
  getIndex(WORDS); // built once at startup in the real bot
  const start = performance.now();
  decideBid({ letter: "E", myBalance: 100, myRack: rack("BCDFGHJKLMNPQRST"), dictionary: WORDS, remainingAuctions: 40 });
  chooseWord({ myRack: rack("BCDFGHJKLMNPQRSTVWXZ"), dictionary: WORDS, remainingAuctions: 40 });
  assert.ok(performance.now() - start < 150, "a decision took 150 ms or more");
});
