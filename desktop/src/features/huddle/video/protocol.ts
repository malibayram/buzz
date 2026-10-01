export const CODEC = "avc1.42E01F";
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
      return "This huddle already has 8 cameras";
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

export function cameraPublish() {
  return {
    type: "publish",
    track: TRACK_CAMERA,
    codec: CODEC,
    layers: [
      { layer: 0, w: 320, h: 180, max_kbps: 150 },
      { layer: 1, w: 1280, h: 720, max_kbps: 1200 },
    ],
  };
}

export function screenPublish(width: number, height: number) {
  return {
    type: "publish",
    track: TRACK_SCREEN,
    codec: CODEC,
    layers: [{ layer: 0, w: width, h: height, max_kbps: 2500 }],
  };
}
