import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_CAMERA_KEY,
  buildStageTiles,
  dockTile,
  gridColumns,
  layoutStage,
} from "./stageLayout.ts";
import { planSubscriptions } from "./subscriptions.ts";

const cam = (pubkey, peerIndex) => ({
  key: `${peerIndex}:0:0`,
  peerIndex,
  epoch: 0,
  pubkey,
  track: 0,
});
const screen = (pubkey, peerIndex) => ({
  key: `${peerIndex}:0:1`,
  peerIndex,
  epoch: 0,
  pubkey,
  track: 1,
});

test("every participant gets one tile, self last, screens first", () => {
  const tiles = buildStageTiles({
    participants: ["me", "Bob", "carol"],
    selfPubkey: "ME",
    remote: [cam("bob", 1), screen("carol", 2), cam("dave", 3)],
    localCamera: true,
  });
  assert.deepEqual(
    tiles.map((t) => [t.kind, t.pubkey]),
    [
      ["screen", "carol"],
      ["camera", "Bob"],
      ["avatar", "carol"],
      ["camera", "dave"],
      ["camera", "ME"],
    ],
  );
  assert.equal(tiles.at(-1).key, LOCAL_CAMERA_KEY);
});

test("grid columns grow with the call", () => {
  assert.deepEqual([1, 2, 4, 5, 9, 10].map(gridColumns), [1, 2, 2, 3, 3, 4]);
});

test("auto layout: grid, then presentation for a share; a pin wins", () => {
  const people = buildStageTiles({
    participants: ["a", "b", "c", "d"],
    selfPubkey: "a",
    remote: [cam("b", 1), cam("c", 2)],
    localCamera: false,
  });
  const grid = layoutStage({
    tiles: people,
    pinnedKey: null,
    preference: "auto",
    activeSpeakers: [],
  });
  assert.equal(grid.mode, "grid");
  assert.equal(grid.large.size, 0, "four tiles use the low layer");

  const withShare = buildStageTiles({
    participants: ["a", "b", "c"],
    selfPubkey: "a",
    remote: [cam("b", 1), screen("c", 2)],
    localCamera: false,
  });
  const shared = layoutStage({
    tiles: withShare,
    pinnedKey: null,
    preference: "auto",
    activeSpeakers: [],
  });
  assert.equal(shared.mode, "presentation");
  assert.equal(shared.main.kind, "screen");
  assert.deepEqual([...shared.large], [shared.main.key]);

  const pinned = layoutStage({
    tiles: withShare,
    pinnedKey: "1:0:0",
    preference: "auto",
    activeSpeakers: [],
  });
  assert.equal(pinned.main.key, "1:0:0");
});

test("speaker layout follows the active remote speaker", () => {
  const tiles = buildStageTiles({
    participants: ["a", "b", "c"],
    selfPubkey: "a",
    remote: [cam("b", 1), cam("c", 2)],
    localCamera: true,
  });
  const model = layoutStage({
    tiles,
    pinnedKey: null,
    preference: "speaker",
    activeSpeakers: ["a", "C"],
  });
  assert.equal(model.mode, "presentation");
  assert.equal(model.main.pubkey, "c");
});

test("a small call puts every tile on the high layer", () => {
  const tiles = buildStageTiles({
    participants: ["a", "b"],
    selfPubkey: "a",
    remote: [cam("b", 1)],
    localCamera: true,
  });
  const model = layoutStage({
    tiles,
    pinnedKey: null,
    preference: "auto",
    activeSpeakers: [],
  });
  assert.equal(model.mode, "grid");
  assert.ok(model.large.has("1:0:0"));
});

test("dock prefers a share, then pin, then speaker; none without video", () => {
  const tiles = buildStageTiles({
    participants: ["a", "b", "c"],
    selfPubkey: "a",
    remote: [cam("b", 1), cam("c", 2)],
    localCamera: false,
  });
  assert.equal(
    dockTile({ tiles, pinnedKey: "1:0:0", activeSpeakers: ["c"] }).key,
    "1:0:0",
  );
  assert.equal(
    dockTile({ tiles, pinnedKey: null, activeSpeakers: ["c"] }).key,
    "2:0:0",
  );
  const quiet = buildStageTiles({
    participants: ["a", "b"],
    selfPubkey: "a",
    remote: [],
    localCamera: false,
  });
  assert.equal(
    dockTile({ tiles: quiet, pinnedKey: null, activeSpeakers: [] }),
    null,
  );
});

test("subscriptions: hidden tiles off, screens layer 0, large cameras layer 1", () => {
  const remote = [cam("b", 1), cam("c", 2), screen("d", 3)];
  const plan = planSubscriptions(
    remote,
    new Map([
      ["1:0:0", { large: true }],
      ["3:0:1", { large: true }],
    ]),
  );
  assert.deepEqual(Object.fromEntries(plan), {
    "1:0:0": 1,
    "2:0:0": null,
    "3:0:1": 0,
  });
});

test("our own published tracks never become remote tiles", () => {
  const tiles = buildStageTiles({
    participants: ["me", "bob"],
    selfPubkey: "me",
    remote: [screen("ME", 0), cam("me", 0), cam("bob", 1)],
    localCamera: false,
  });
  assert.deepEqual(
    tiles.map((t) => [t.kind, t.pubkey, t.isSelf]),
    [
      ["camera", "bob", false],
      ["avatar", "me", true],
    ],
  );
});
