/** Wire label for every huddle video track (H.264 Constrained Baseline). */
export const CODEC = "avc1.42E01F";
/** Level 4.0: what a >720p screen share needs; level 3.1 caps at 1280×720. */
const CODEC_LEVEL_40 = "avc1.42E028";
/**
 * Decoders take a permissive level (5.1) because the label's level is not a
 * promise: a screen share above 720p arrives at level 4.0.
 */
export const DECODER_CODEC = "avc1.42E033";
export const TRACK_CAMERA = 0;
export const TRACK_SCREEN = 1;
const HEADER_LEN = 12;
const FLAG_KEYFRAME = 1;

export type TrackSnap = {
  track: number;
  codec: string;
  layers: Array<{ layer: number }>;
};

export type PeerTracks = {
  peerIndex: number;
  epoch: number;
  pubkey: string;
  tracks: TrackSnap[];
};

export type RelayVideoFrame = {
  peerIndex: number;
  epoch: number;
  track: number;
  layer: number;
  keyframe: boolean;
  timestamp: number;
  annexB: Uint8Array;
};

export function encodeFrame(
  track: number,
  layer: number,
  keyframe: boolean,
  seq: number,
  ts90k: number,
  annexB: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + annexB.byteLength);
  const view = new DataView(out.buffer);
  out[0] = track;
  out[1] = layer;
  out[2] = keyframe ? FLAG_KEYFRAME : 0;
  view.setUint32(4, seq >>> 0);
  view.setUint32(8, ts90k >>> 0);
  out.set(annexB, HEADER_LEN);
  return out;
}

export function decodeRelayFrame(data: ArrayBuffer): RelayVideoFrame | null {
  if (data.byteLength < 2 + HEADER_LEN) return null;
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  return {
    peerIndex: bytes[0] ?? 0,
    epoch: bytes[1] ?? 0,
    track: bytes[2] ?? 0,
    layer: bytes[3] ?? 0,
    keyframe: ((bytes[4] ?? 0) & FLAG_KEYFRAME) !== 0,
    timestamp: view.getUint32(10),
    annexB: bytes.subarray(2 + HEADER_LEN),
  };
}

export function parseControl(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readPeers(value: unknown): PeerTracks[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const peerIndex = row.peer_index;
    const epoch = row.epoch;
    const pubkey = row.pubkey;
    if (typeof peerIndex !== "number" || typeof epoch !== "number") return [];
    if (typeof pubkey !== "string" || !Array.isArray(row.tracks)) return [];
    const tracks = row.tracks.flatMap((track) => {
      if (!track || typeof track !== "object") return [];
      const item = track as Record<string, unknown>;
      if (typeof item.track !== "number") return [];
      return [
        {
          track: item.track,
          codec: typeof item.codec === "string" ? item.codec : CODEC,
          layers: [],
        },
      ];
    });
    return [{ peerIndex, epoch, pubkey, tracks }];
  });
}

export function videoErrorText(code: string): string {
  switch (code) {
    case "screen_share_busy":
      return "Someone else is sharing their screen";
    case "camera_limit":
      return "This huddle already has 8 cameras on";
    case "frame_too_large":
      return "A video frame was too large";
    case "huddle_video_unavailable_on_mesh":
      return "Video is unavailable on this server";
    case "huddle_video_unavailable":
      return "Video is turned off on this server";
    case "video_requires_audio_peer":
      return "Join huddle audio before turning on video";
    case "unsupported_version":
      return "This huddle is not using the video protocol";
    default:
      return "Video is unavailable";
  }
}

export type VideoTile = {
  key: string;
  peerIndex: number;
  epoch: number;
  pubkey: string;
  track: number;
};

export function tileKey(peer: number, epoch: number, track: number): string {
  return `${peer}:${epoch}:${track}`;
}

export type LayerSpec = {
  layer: number;
  width: number;
  height: number;
  bitrate: number;
  fps: number;
  codec: string;
};

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Scale a source to `targetHeight` (never upscaling), keeping its aspect. */
export function scaledSize(
  width: number,
  height: number,
  targetHeight: number,
): { width: number; height: number } {
  const h = Math.min(targetHeight, Math.max(height, 2));
  return {
    width: even((h * Math.max(width, 2)) / Math.max(height, 2)),
    height: even(h),
  };
}

/** Low layer for grids, high layer for the main tile. Sized for 5–8 people. */
export function cameraLayers(width: number, height: number): LayerSpec[] {
  return [
    {
      layer: 0,
      ...scaledSize(width, height, 240),
      bitrate: 250_000,
      fps: 24,
      codec: CODEC,
    },
    {
      layer: 1,
      ...scaledSize(width, height, 720),
      bitrate: 900_000,
      fps: 24,
      codec: CODEC,
    },
  ];
}

/** One screen layer, fit inside 1920×1080, at the lowest level that holds it. */
export function screenLayer(width: number, height: number): LayerSpec {
  const scale = Math.min(
    1,
    1920 / Math.max(width, 1),
    1080 / Math.max(height, 1),
  );
  const w = even(width * scale);
  const h = even(height * scale);
  return {
    layer: 0,
    width: w,
    height: h,
    bitrate: 1_500_000,
    fps: 15,
    codec: w * h <= 1280 * 720 ? CODEC : CODEC_LEVEL_40,
  };
}

function publishMessage(track: number, layers: LayerSpec[]) {
  return {
    type: "publish",
    track,
    codec: CODEC,
    layers: layers.map((layer) => ({
      layer: layer.layer,
      w: layer.width,
      h: layer.height,
      max_kbps: Math.round(layer.bitrate / 1000),
    })),
  };
}

export function cameraPublish(layers: LayerSpec[]) {
  return publishMessage(TRACK_CAMERA, layers);
}

export function screenPublish(layer: LayerSpec) {
  return publishMessage(TRACK_SCREEN, [layer]);
}
