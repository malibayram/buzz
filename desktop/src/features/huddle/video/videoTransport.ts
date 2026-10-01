import { invoke } from "@tauri-apps/api/core";

import {
  type PeerTracks,
  type RelayVideoFrame,
  cameraPublish,
  decodeRelayFrame,
  parseControl,
  readPeers,
  screenPublish,
} from "./protocol";

export type VideoEvents = {
  onPeers: (peers: PeerTracks[]) => void;
  onDelta: (peer: PeerTracks) => void;
  onKeyframe: (track: number, layer: number) => void;
  onError: (code: string) => void;
  onFrame: (frame: RelayVideoFrame) => void;
};

export type VideoLink = {
  publishCamera: () => void;
  publishScreen: (width: number, height: number) => void;
  unpublish: (track: number) => void;
  subscribe: (
    peerIndex: number,
    epoch: number,
    track: number,
    layer: number | null,
  ) => void;
  sendFrame: (bytes: Uint8Array) => void;
  close: () => void;
};

type FakeConn = {
  send: (data: string | ArrayBuffer) => void;
  close: () => void;
};

type FakeVideo = {
  connect: (onMessage: (data: string | ArrayBuffer) => void) => FakeConn;
};

type VideoInfo = {
  url: string;
  relay_url: string;
  parent_channel_id: string;
};

function fakeVideo(): FakeVideo | null {
  const host = window as Window & { __BUZZ_E2E_FAKE_VIDEO__?: FakeVideo };
  return host.__BUZZ_E2E_FAKE_VIDEO__ ?? null;
}

export function noopVideoLink(): VideoLink {
  return {
    publishCamera: () => undefined,
    publishScreen: () => undefined,
    unpublish: () => undefined,
    subscribe: () => undefined,
    sendFrame: () => undefined,
    close: () => undefined,
  };
}

export async function openVideoLink(
  events: VideoEvents,
  alive: () => boolean,
): Promise<VideoLink> {
  const host = window as Window & { __BUZZ_E2E__?: unknown };
  const fake = fakeVideo();
  if (host.__BUZZ_E2E__ != null && !fake) return noopVideoLink();
  const info = await invoke<VideoInfo>("huddle_video_info");
  if (!alive()) return noopVideoLink();
  const socket = fake ? null : new WebSocket(info.url);
  if (socket) socket.binaryType = "arraybuffer";
  let conn: FakeConn | null = null;
  let resolveChallenge: (value: string) => void = () => undefined;
  const challenge = new Promise<string>((resolve) => {
    resolveChallenge = resolve;
  });
  const deliver = (data: string | ArrayBuffer) => {
    if (typeof data !== "string") {
      const frame = decodeRelayFrame(data);
      if (frame && alive()) events.onFrame(frame);
      return;
    }
    const message = parseControl(data);
    if (!message || !alive()) return;
    if (message.type === "challenge" && typeof message.challenge === "string") {
      resolveChallenge(message.challenge);
      return;
    }
    if (message.type === "tracks") events.onPeers(readPeers(message.peers));
    if (message.type === "track_delta") {
      const [peer] = readPeers([message]);
      if (peer) events.onDelta(peer);
    }
    if (
      message.type === "keyframe_request" &&
      typeof message.track === "number" &&
      typeof message.layer === "number"
    ) {
      events.onKeyframe(message.track, message.layer);
    }
    if (message.type === "error" && typeof message.code === "string") {
      events.onError(message.code);
    }
  };
  if (fake) conn = fake.connect(deliver);
  if (socket) socket.onmessage = (event) => accept(event.data, deliver);
  if (!fake) await waitOpen(socket);
  if (!alive()) {
    conn?.close();
    socket?.close();
    return noopVideoLink();
  }
  const signed = await Promise.race([
    challenge,
    new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), 5000),
    ),
  ]);
  if (!alive() || !signed) {
    conn?.close();
    socket?.close();
    return noopVideoLink();
  }
  const event = await invoke("sign_huddle_video_auth", {
    challenge: signed,
    relayUrl: info.relay_url,
  });
  if (!alive()) {
    conn?.close();
    socket?.close();
    return noopVideoLink();
  }
  const sendRaw = (data: string | ArrayBuffer) => {
    conn?.send(data);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
  };
  sendRaw(
    JSON.stringify({
      type: "auth",
      event,
      parent_channel_id: info.parent_channel_id,
      protocol_version: 4,
    }),
  );
  const sendJson = (body: unknown) => sendRaw(JSON.stringify(body));
  return {
    publishCamera: () => sendJson(cameraPublish()),
    publishScreen: (width, height) => sendJson(screenPublish(width, height)),
    unpublish: (track) => sendJson({ type: "unpublish", track }),
    subscribe: (peerIndex, epoch, track, layer) =>
      sendJson({
        type: "subscribe",
        peer_index: peerIndex,
        epoch,
        track,
        layer,
      }),
    sendFrame: (bytes) => {
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      sendRaw(copy);
    },
    close: () => {
      conn?.close();
      socket?.close();
    },
  };
}

function accept(data: unknown, deliver: (value: string | ArrayBuffer) => void) {
  if (typeof data === "string" || data instanceof ArrayBuffer) deliver(data);
}

function waitOpen(socket: WebSocket | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error("video socket missing"));
      return;
    }
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("video socket failed"));
  });
}
