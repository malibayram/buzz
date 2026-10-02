import { invoke } from "@tauri-apps/api/core";

import {
  type LayerSpec,
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
  publishCamera: (layers: LayerSpec[]) => void;
  publishScreen: (layer: LayerSpec) => void;
  unpublish: (track: number) => void;
  subscribe: (
    peerIndex: number,
    epoch: number,
    track: number,
    layer: number | null,
  ) => void;
  sendFrame: (bytes: Uint8Array) => void;
  /** Bytes queued in the socket but not yet handed to the network. */
  backlog: () => number;
  close: () => void;
};

type FakeConn = {
  send: (data: string | ArrayBuffer) => void;
  close: () => void;
};

type FakeVideo = {
  connect: (
    onMessage: (data: string | ArrayBuffer) => void,
    onClose?: () => void,
  ) => FakeConn;
};

type VideoInfo = {
  url: string;
  relay_url: string;
  parent_channel_id: string;
};

const HANDSHAKE_TIMEOUT_MS = 5000;

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
    backlog: () => 0,
    close: () => undefined,
  };
}

/**
 * One authenticated video socket. Resolves once auth is sent and rejects when
 * the socket or handshake fails; `onClose` fires once if an open link drops.
 * Reconnecting is the caller's job (see `linkSupervisor`).
 */
export async function openVideoLink(
  events: VideoEvents,
  onClose: () => void,
): Promise<VideoLink> {
  const host = window as Window & { __BUZZ_E2E__?: unknown };
  const fake = fakeVideo();
  if (host.__BUZZ_E2E__ != null && !fake) return noopVideoLink();
  const info = await invoke<VideoInfo>("huddle_video_info");
  let closed = false;
  let opened = false;
  const notifyClosed = () => {
    if (closed) return;
    closed = true;
    if (opened) onClose();
  };
  let resolveChallenge: (value: string) => void = () => undefined;
  let rejectChallenge: (error: Error) => void = () => undefined;
  const challenge = new Promise<string>((resolve, reject) => {
    resolveChallenge = resolve;
    rejectChallenge = reject;
  });
  const deliver = (data: string | ArrayBuffer) => {
    if (closed) return;
    if (typeof data !== "string") {
      const frame = decodeRelayFrame(data);
      if (frame) events.onFrame(frame);
      return;
    }
    const message = parseControl(data);
    if (!message) return;
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
  const lost = () => {
    rejectChallenge(new Error("Video connection closed"));
    notifyClosed();
  };

  let conn: FakeConn | null = null;
  let socket: WebSocket | null = null;
  if (fake) {
    conn = fake.connect(deliver, lost);
  } else {
    socket = new WebSocket(info.url);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        deliver(event.data);
      }
    };
    socket.onclose = lost;
    socket.onerror = lost;
  }
  const shut = () => {
    closed = true;
    conn?.close();
    socket?.close();
  };
  try {
    if (socket) await waitOpen(socket);
    const signed = await withTimeout(challenge, HANDSHAKE_TIMEOUT_MS);
    const event = await invoke("sign_huddle_video_auth", {
      challenge: signed,
      relayUrl: info.relay_url,
    });
    if (closed) throw new Error("Video connection closed");
    const sendRaw = (data: string | ArrayBuffer) => {
      if (closed) return;
      conn?.send(data);
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    };
    sendRaw(
      JSON.stringify({
        type: "auth",
        event,
        parent_channel_id: info.parent_channel_id,
        protocol_version: 4,
      }),
    );
    opened = true;
    const sendJson = (body: unknown) => sendRaw(JSON.stringify(body));
    return {
      publishCamera: (layers) => sendJson(cameraPublish(layers)),
      publishScreen: (layer) => sendJson(screenPublish(layer)),
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
      backlog: () => socket?.bufferedAmount ?? 0,
      close: shut,
    };
  } catch (error) {
    shut();
    throw error;
  }
}

function waitOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "close",
      () => reject(new Error("Video connection failed")),
      { once: true },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Video handshake timed out")),
      ms,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
