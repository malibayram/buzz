import { CODEC, DECODER_CODEC } from "./protocol";

export type TileDecoder = {
  push: (keyframe: boolean, timestamp: number, data: Uint8Array) => void;
  /** Draw into this canvas from now on; `null` detaches (decoding continues). */
  attach: (canvas: HTMLCanvasElement | null) => void;
  close: () => void;
};

type DecoderOptions = {
  /** Decoded output stopped (or resumed). Drives the tile's "paused" state. */
  onStall: (stalled: boolean) => void;
  /** Ask the relay for a fresh keyframe (it re-arms on `subscribe`). */
  requestKeyframe: () => void;
  /** No output for this long counts as a stall. */
  stallMs?: number;
};

type DecoderDeps = {
  VideoDecoder?: typeof VideoDecoder;
  EncodedVideoChunk?: typeof EncodedVideoChunk;
  now: () => number;
  repeat: (callback: () => void, ms: number) => () => void;
};

const browserDeps = (): DecoderDeps => ({
  VideoDecoder: globalThis.VideoDecoder,
  EncodedVideoChunk: globalThis.EncodedVideoChunk,
  now: () => performance.now(),
  repeat: (callback, ms) => {
    const id = window.setInterval(callback, ms);
    return () => window.clearInterval(id);
  },
});

const WATCHDOG_MS = 1000;
const DEFAULT_STALL_MS = 2500;

/**
 * One remote track's decoder. It lives as long as the subscription, not the
 * canvas, so a keyframe that lands before React mounts the tile still primes
 * it. Deltas are dropped until a keyframe; any decode error rebuilds the
 * decoder and asks for a new keyframe instead of leaving the tile black.
 */
export function createTileDecoder(
  { onStall, requestKeyframe, stallMs = DEFAULT_STALL_MS }: DecoderOptions,
  deps: DecoderDeps = browserDeps(),
): TileDecoder {
  const { VideoDecoder: Decoder, EncodedVideoChunk: Chunk } = deps;
  let decoder: VideoDecoder | null = null;
  let waitingForKey = true;
  let codec = DECODER_CODEC;
  let decodedAny = false;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let lastOutput = deps.now();
  let lastAsk = Number.NEGATIVE_INFINITY;
  let stalled = false;
  let closed = false;

  const ask = () => {
    const now = deps.now();
    if (now - lastAsk < stallMs) return;
    lastAsk = now;
    requestKeyframe();
  };
  const reset = () => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    // A config the platform rejects before any output: fall back to the label.
    if (!decodedAny) codec = CODEC;
    waitingForKey = true;
    if (!closed) ask();
  };
  const draw = (frame: VideoFrame) => {
    decodedAny = true;
    lastOutput = deps.now();
    if (stalled) {
      stalled = false;
      onStall(false);
    }
    if (canvas && context) {
      if (canvas.width !== frame.displayWidth)
        canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) {
        canvas.height = frame.displayHeight;
      }
      context.drawImage(frame, 0, 0);
    }
    frame.close();
  };
  const build = (): VideoDecoder | null => {
    if (!Decoder) return null;
    const next = new Decoder({ output: draw, error: reset });
    try {
      next.configure({ codec, optimizeForLatency: true });
    } catch {
      codec = CODEC;
      next.configure({ codec, optimizeForLatency: true });
    }
    return next;
  };
  const stopWatchdog = deps.repeat(() => {
    if (closed || deps.now() - lastOutput < stallMs) return;
    if (!stalled) {
      stalled = true;
      onStall(true);
    }
    ask();
  }, WATCHDOG_MS);

  return {
    push(keyframe, timestamp, data) {
      if (closed || !Chunk) return;
      if (waitingForKey && !keyframe) return;
      if (!decoder || decoder.state === "closed") decoder = build();
      if (!decoder) return;
      waitingForKey = false;
      try {
        decoder.decode(
          new Chunk({ type: keyframe ? "key" : "delta", timestamp, data }),
        );
      } catch {
        reset();
      }
    },
    attach(next) {
      canvas = next;
      context = next?.getContext("2d") ?? null;
    },
    close() {
      closed = true;
      stopWatchdog();
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      canvas = null;
      context = null;
    },
  };
}
