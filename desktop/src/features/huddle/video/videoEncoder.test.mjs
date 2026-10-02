import assert from "node:assert/strict";
import test from "node:test";

import { BACKLOG_LIMIT_BYTES, startEncode } from "./videoEncoder.ts";

const LAYERS = [
  { layer: 0, width: 426, height: 240, bitrate: 250_000, fps: 24, codec: "c" },
  { layer: 1, width: 1280, height: 720, bitrate: 900_000, fps: 24, codec: "c" },
];

function harness() {
  let now = 0;
  let tick = () => undefined;
  const encoders = [];
  class FakeEncoder {
    constructor() {
      this.state = "unconfigured";
      this.encodeQueueSize = 0;
      this.encoded = [];
      this.bitrates = [];
      encoders.push(this);
    }
    configure(config) {
      this.state = "configured";
      this.bitrates.push(config.bitrate);
    }
    encode(_frame, options) {
      this.encoded.push(options.keyFrame);
    }
    close() {
      this.state = "closed";
    }
  }
  const deps = {
    VideoEncoder: FakeEncoder,
    surface: () => ({
      draw: () => undefined,
      frame: () => ({ close: () => undefined }),
    }),
    now: () => now,
    schedule: (callback) => {
      tick = callback;
      return () => undefined;
    },
  };
  return {
    encoders,
    deps,
    step(ms) {
      now += ms;
      tick();
    },
  };
}

function start(h, backlog, keyframeEveryMs = 60_000) {
  return startEncode(
    {
      source: { readyState: 4 },
      track: 0,
      layers: LAYERS,
      sink: () => undefined,
      backlog,
      wantsKey: () => false,
      keyframeEveryMs,
    },
    h.deps,
  );
}

test("congestion drops the high layer first and keys it on recovery", () => {
  const h = harness();
  let backlog = 0;
  start(h, () => backlog);
  h.step(100);
  const [low, high] = h.encoders;
  assert.deepEqual([low.encoded, high.encoded], [[true], [true]]);
  h.step(100);
  assert.deepEqual([low.encoded.at(-1), high.encoded.at(-1)], [false, false]);

  backlog = BACKLOG_LIMIT_BYTES + 1;
  h.step(100);
  assert.equal(high.encoded.length, 2, "high layer paused");
  assert.equal(low.encoded.length, 3, "low layer still sends");

  backlog = BACKLOG_LIMIT_BYTES * 2 + 1;
  h.step(100);
  assert.equal(low.encoded.length, 3, "low layer pauses past twice the limit");

  backlog = 0;
  h.step(100);
  assert.equal(high.encoded.at(-1), true, "recovery starts on a keyframe");
  assert.equal(low.encoded.at(-1), true);
});

test("sustained congestion lowers bitrate, clear air restores it", () => {
  const h = harness();
  let backlog = BACKLOG_LIMIT_BYTES + 1;
  start(h, () => backlog);
  const high = h.encoders[1];
  for (let i = 0; i < 25; i += 1) h.step(100);
  assert.ok(high.bitrates.at(-1) < 900_000, "bitrate stepped down");
  backlog = 0;
  for (let i = 0; i < 400; i += 1) h.step(100);
  assert.equal(high.bitrates.at(-1), 900_000, "bitrate recovers to nominal");
});

test("a periodic keyframe arrives without any request", () => {
  const h = harness();
  start(h, () => 0, 3000);
  h.step(100);
  for (let i = 0; i < 29; i += 1) h.step(100);
  const high = h.encoders[1];
  assert.equal(high.encoded.filter(Boolean).length, 1);
  h.step(100);
  assert.equal(high.encoded.filter(Boolean).length, 2);
});
