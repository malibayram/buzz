import { encodeFrame, type LayerSpec } from "./protocol";

type Sink = (bytes: Uint8Array) => void;
type KeyCheck = (track: number, layer: number) => boolean;

type Surface = {
  draw: (source: CanvasImageSource) => void;
  frame: (timestampUs: number) => VideoFrame;
};

export type EncoderDeps = {
  VideoEncoder?: typeof VideoEncoder;
  surface: (width: number, height: number) => Surface | null;
  now: () => number;
  /** Run `tick` on the next source frame, or after `fallbackMs` if none comes. */
  schedule: (tick: () => void, fallbackMs: number) => () => void;
};

export type EncodeOptions = {
  source: HTMLVideoElement;
  track: number;
  layers: LayerSpec[];
  sink: Sink;
  /** Bytes the socket has queued but not yet sent. */
  backlog: () => number;
  wantsKey: KeyCheck;
  keyframeEveryMs: number;
};

/** Above this backlog the high layer stops sending; the low layer at twice it. */
export const BACKLOG_LIMIT_BYTES = 128 * 1024;
const LOWER_AFTER_MS = 2000;
const RAISE_EVERY_MS = 5000;
const LOWER_FACTOR = 0.7;
const RAISE_FACTOR = 1.15;
const FLOOR_FACTOR = 0.3;
const MAX_ENCODE_QUEUE = 2;
/** Keep sending at least this often so a static screen never looks stalled. */
const IDLE_TICK_MS = 1000;
/** Back-off before rebuilding an encoder that errored or was rejected. */
const REBUILD_AFTER_MS = 2000;

type LayerState = {
  spec: LayerSpec;
  surface: Surface | null;
  encoder: VideoEncoder | null;
  bitrate: number;
  lastEncode: number;
  lastKey: number;
  needKey: boolean;
  congestedSince: number | null;
  lastAdjust: number;
  /** After an encoder failure, do not rebuild before this time. */
  retryAt: number;
};

function browserSurface(width: number, height: number): Surface | null {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas === "undefined"
      ? Object.assign(document.createElement("canvas"), { width, height })
      : new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) return null;
  return {
    draw: (source) => context.drawImage(source, 0, 0, width, height),
    frame: (timestamp) => new VideoFrame(canvas, { timestamp }),
  };
}

export const browserEncoderDeps = (video: HTMLVideoElement): EncoderDeps => ({
  VideoEncoder: globalThis.VideoEncoder,
  surface: browserSurface,
  now: () => performance.now(),
  schedule: (tick, fallbackMs) => {
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      tick();
    };
    const timer = window.setTimeout(fire, fallbackMs);
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(fire);
    } else {
      requestAnimationFrame(fire);
    }
    return () => {
      done = true;
      window.clearTimeout(timer);
    };
  },
});

export function videoCodecsSupported(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof VideoFrame !== "undefined"
  );
}

/**
 * Encode one capture into its layers. Each layer is scaled explicitly, sends
 * a periodic keyframe, recreates its encoder after an error, and backs off
 * (skip, then lower bitrate) while the socket is congested so video never
 * queues ahead of huddle audio.
 */
export function startEncode(
  {
    source,
    track,
    layers,
    sink,
    backlog,
    wantsKey,
    keyframeEveryMs,
  }: EncodeOptions,
  deps: EncoderDeps = browserEncoderDeps(source),
): () => void {
  const { VideoEncoder: Encoder } = deps;
  if (!Encoder) return () => undefined;
  let stopped = false;
  let seq = 0;
  let cancelTick: () => void = () => undefined;
  const origin = deps.now();

  const configure = (state: LayerState) => {
    state.encoder?.configure({
      codec: state.spec.codec,
      width: state.spec.width,
      height: state.spec.height,
      bitrate: Math.round(state.bitrate),
      framerate: state.spec.fps,
      latencyMode: "realtime",
      hardwareAcceleration: "no-preference",
      avc: { format: "annexb" },
    } as VideoEncoderConfig);
  };
  const build = (state: LayerState) => {
    const encoder = new Encoder({
      output: (chunk) => {
        if (stopped) return;
        const annex = new Uint8Array(chunk.byteLength);
        chunk.copyTo(annex);
        const ts = Math.round((deps.now() - origin) * 90);
        sink(
          encodeFrame(
            track,
            state.spec.layer,
            chunk.type === "key",
            seq,
            ts,
            annex,
          ),
        );
        seq = (seq + 1) >>> 0;
      },
      error: (error) => {
        console.warn("[huddle-video] encoder error, rebuilding", error);
        if (state.encoder === encoder) state.encoder = null;
        state.needKey = true;
        state.retryAt = deps.now() + REBUILD_AFTER_MS;
      },
    });
    state.encoder = encoder;
    try {
      configure(state);
    } catch (error) {
      console.warn("[huddle-video] encoder config rejected", state.spec, error);
      encoder.close();
      state.encoder = null;
      state.retryAt = deps.now() + REBUILD_AFTER_MS;
    }
  };

  const states: LayerState[] = layers.map((spec) => ({
    spec,
    surface: deps.surface(spec.width, spec.height),
    encoder: null,
    bitrate: spec.bitrate,
    lastEncode: Number.NEGATIVE_INFINITY,
    lastKey: Number.NEGATIVE_INFINITY,
    needKey: true,
    congestedSince: null,
    lastAdjust: Number.NEGATIVE_INFINITY,
    retryAt: Number.NEGATIVE_INFINITY,
  }));
  for (const state of states) build(state);

  const adapt = (state: LayerState, now: number): boolean => {
    const limit = BACKLOG_LIMIT_BYTES * (state.spec.layer === 0 ? 2 : 1);
    if (backlog() > limit) {
      state.congestedSince ??= now;
      state.needKey = true;
      if (
        now - state.congestedSince >= LOWER_AFTER_MS &&
        now - state.lastAdjust >= LOWER_AFTER_MS
      ) {
        state.bitrate = Math.max(
          state.spec.bitrate * FLOOR_FACTOR,
          state.bitrate * LOWER_FACTOR,
        );
        state.lastAdjust = now;
        configure(state);
      }
      return false;
    }
    state.congestedSince = null;
    if (
      state.bitrate < state.spec.bitrate &&
      now - state.lastAdjust >= RAISE_EVERY_MS
    ) {
      state.bitrate = Math.min(
        state.spec.bitrate,
        state.bitrate * RAISE_FACTOR,
      );
      state.lastAdjust = now;
      configure(state);
    }
    return true;
  };

  const tick = () => {
    if (stopped) return;
    if (source.readyState >= 2) {
      const now = deps.now();
      for (const state of states) {
        if (now - state.lastEncode < 1000 / state.spec.fps) continue;
        if (!state.encoder && now >= state.retryAt) build(state);
        const encoder = state.encoder;
        if (encoder?.state !== "configured" || !state.surface) continue;
        if (!adapt(state, now)) continue;
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) continue;
        const requested = wantsKey(track, state.spec.layer);
        const keyFrame =
          requested || state.needKey || now - state.lastKey >= keyframeEveryMs;
        try {
          state.surface.draw(source);
          const frame = state.surface.frame(Math.round((now - origin) * 1000));
          encoder.encode(frame, { keyFrame });
          frame.close();
        } catch (error) {
          console.warn("[huddle-video] encode failed", error);
          state.needKey = true;
          continue;
        }
        state.lastEncode = now;
        if (keyFrame) {
          state.lastKey = now;
          state.needKey = false;
        }
      }
    }
    cancelTick = deps.schedule(tick, IDLE_TICK_MS);
  };
  cancelTick = deps.schedule(tick, IDLE_TICK_MS);

  return () => {
    stopped = true;
    cancelTick();
    for (const state of states) {
      if (state.encoder && state.encoder.state !== "closed")
        state.encoder.close();
      state.encoder = null;
    }
  };
}
