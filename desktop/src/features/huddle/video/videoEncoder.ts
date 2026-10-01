import { CODEC, encodeFrame } from "./protocol";

type Layer = {
  layer: number;
  width: number;
  height: number;
  bitrate: number;
  fps: number;
};

const CAMERA_LAYERS: Layer[] = [
  { layer: 0, width: 320, height: 180, bitrate: 150_000, fps: 24 },
  { layer: 1, width: 1280, height: 720, bitrate: 1_200_000, fps: 24 },
];

type Sink = (bytes: Uint8Array) => void;
type KeyCheck = (track: number, layer: number) => boolean;

function startEncode(
  video: HTMLVideoElement,
  track: number,
  layers: Layer[],
  sink: Sink,
  wantsKey: KeyCheck,
): () => void {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof VideoFrame === "undefined"
  ) {
    return () => undefined;
  }
  let stopped = false;
  let seq = 0;
  const origin = performance.now();
  const last = new Map<number, number>();
  const encoders = layers.map((layer) => {
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const annex = new Uint8Array(chunk.byteLength);
        chunk.copyTo(annex);
        const ts = Math.round((performance.now() - origin) * 90);
        sink(
          encodeFrame(track, layer.layer, chunk.type === "key", seq, ts, annex),
        );
        seq = (seq + 1) >>> 0;
      },
      error: () => undefined,
    });
    encoder.configure({
      codec: CODEC,
      width: layer.width,
      height: layer.height,
      bitrate: layer.bitrate,
      framerate: layer.fps,
      latencyMode: "realtime",
      hardwareAcceleration: "no-preference",
      avc: { format: "annexb" },
    } as VideoEncoderConfig);
    return encoder;
  });
  const tick = () => {
    if (stopped || video.readyState < 2) {
      schedule();
      return;
    }
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(video);
    } catch {
      schedule();
      return;
    }
    const now = performance.now();
    layers.forEach((layer, index) => {
      const encoder = encoders[index];
      if (encoder == null) return;
      if (encoder.state !== "configured") return;
      const previous = last.get(layer.layer) ?? 0;
      if (now - previous < 1000 / layer.fps) return;
      last.set(layer.layer, now);
      encoder.encode(frame, { keyFrame: wantsKey(track, layer.layer) });
    });
    frame.close();
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(() => tick());
      return;
    }
    requestAnimationFrame(() => tick());
  };
  schedule();
  return () => {
    stopped = true;
    for (const encoder of encoders) {
      if (encoder.state !== "closed") encoder.close();
    }
  };
}

export function startCameraEncode(
  video: HTMLVideoElement,
  sink: Sink,
  wantsKey: KeyCheck,
): () => void {
  return startEncode(video, 0, CAMERA_LAYERS, sink, wantsKey);
}

export function startScreenEncode(
  video: HTMLVideoElement,
  width: number,
  height: number,
  sink: Sink,
  wantsKey: KeyCheck,
): () => void {
  const scale = Math.min(
    1,
    1920 / Math.max(width, 1),
    1080 / Math.max(height, 1),
  );
  return startEncode(
    video,
    1,
    [
      {
        layer: 0,
        width: Math.max(2, Math.round((width * scale) / 2) * 2),
        height: Math.max(2, Math.round((height * scale) / 2) * 2),
        bitrate: 2_500_000,
        fps: 10,
      },
    ],
    sink,
    wantsKey,
  );
}
