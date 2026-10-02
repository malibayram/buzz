import assert from "node:assert/strict";
import test from "node:test";

import { createTileDecoder } from "./videoDecoder.ts";

function harness() {
  const decoders = [];
  let now = 0;
  let watchdog = () => undefined;
  class FakeDecoder {
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = "unconfigured";
      this.decoded = [];
      decoders.push(this);
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk) {
      this.decoded.push(chunk.type);
    }
    close() {
      this.state = "closed";
    }
  }
  class FakeChunk {
    constructor({ type }) {
      this.type = type;
    }
  }
  const deps = {
    VideoDecoder: FakeDecoder,
    EncodedVideoChunk: FakeChunk,
    now: () => now,
    repeat: (callback) => {
      watchdog = callback;
      return () => undefined;
    },
  };
  return {
    decoders,
    deps,
    advance: (ms) => {
      now += ms;
      watchdog();
    },
  };
}

const bytes = new Uint8Array([0, 0, 0, 1]);
const frame = { displayWidth: 2, displayHeight: 2, close: () => undefined };

test("drops deltas until the first keyframe", () => {
  const h = harness();
  const decoder = createTileDecoder(
    { onStall: () => undefined, requestKeyframe: () => undefined },
    h.deps,
  );
  decoder.push(false, 0, bytes);
  assert.equal(h.decoders.length, 0, "no decoder built for a leading delta");
  decoder.push(true, 1, bytes);
  decoder.push(false, 2, bytes);
  assert.deepEqual(h.decoders[0].decoded, ["key", "delta"]);
});

test("a decode error rebuilds, waits for a keyframe, and asks for one", () => {
  const h = harness();
  let asks = 0;
  const decoder = createTileDecoder(
    { onStall: () => undefined, requestKeyframe: () => (asks += 1) },
    h.deps,
  );
  decoder.push(true, 0, bytes);
  h.decoders[0].error(new Error("corrupt"));
  assert.equal(h.decoders[0].state, "closed");
  assert.equal(asks, 1);
  decoder.push(false, 1, bytes);
  assert.equal(h.decoders.length, 1, "deltas after an error are dropped");
  decoder.push(true, 2, bytes);
  assert.equal(h.decoders.length, 2, "a keyframe primes a fresh decoder");
  assert.deepEqual(h.decoders[1].decoded, ["key"]);
});

test("the watchdog reports a stall, re-asks, and clears on output", () => {
  const h = harness();
  const stalls = [];
  let asks = 0;
  const decoder = createTileDecoder(
    {
      stallMs: 2000,
      onStall: (value) => stalls.push(value),
      requestKeyframe: () => (asks += 1),
    },
    h.deps,
  );
  h.advance(1000);
  assert.deepEqual(stalls, []);
  h.advance(1500);
  assert.deepEqual(stalls, [true]);
  assert.equal(asks, 1);
  decoder.push(true, 0, bytes);
  h.decoders[0].output(frame);
  assert.deepEqual(stalls, [true, false]);
});
