import { strict as assert } from "node:assert";
import test from "node:test";

import { npubEncode } from "nostr-tools/nip19";

import { rosterAddCandidatePubkeys } from "./rosterAddCandidates.ts";

const ALICE =
  "4f1df54326295bf820ba88a36f9c65444183949963f0cc4aa7f2b3edcef98b7a";
const BOB = "b3b6207e25e0e8b7b22cc1af3000000000000000000000000000000000000000";
const roster = [ALICE, BOB.toUpperCase()];

function match(query) {
  return rosterAddCandidatePubkeys({
    minQueryLength: 2,
    query,
    rosterPubkeys: roster,
  });
}

test("a hex prefix matches roster members without a profile", () => {
  assert.deepEqual(match("4f1d"), [ALICE]);
  assert.deepEqual(match("  B3B6 "), [BOB]);
});

test("an npub prefix matches roster members", () => {
  assert.deepEqual(match(npubEncode(ALICE).slice(0, 12)), [ALICE]);
});

test("a full pasted key is offered even outside the roster", () => {
  const outsider = "c".repeat(64);
  assert.deepEqual(match(outsider), [outsider]);
  assert.deepEqual(match(npubEncode(outsider)), [outsider]);
});

test("names and too-short fragments do not match by key", () => {
  assert.deepEqual(match("4"), []);
  assert.deepEqual(match("ada"), []);
  assert.deepEqual(match("ff"), []);
});
