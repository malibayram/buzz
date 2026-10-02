import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as React from "react";

import { createLinkSupervisor, type LinkState } from "./linkSupervisor";
import {
  TRACK_SCREEN,
  tileKey,
  videoErrorText,
  type PeerTracks,
  type VideoTile,
} from "./protocol";
import { planSubscriptions, type TileView } from "./subscriptions";
import { createTileDecoder, type TileDecoder } from "./videoDecoder";
import { openVideoLink, type VideoLink } from "./videoTransport";

/** Relay errors a reconnect cannot fix. */
const TERMINAL_ERRORS = new Set([
  "huddle_video_unavailable",
  "huddle_video_unavailable_on_mesh",
  "unsupported_version",
  "auth_failed",
]);

type Args = {
  enabled: boolean;
  linkRef: React.RefObject<VideoLink>;
  requestKey: (track: number, layer: number) => void;
  /** A fresh link opened: re-announce local tracks on it. */
  onLinkOpen: (link: VideoLink) => void;
  release: () => void;
  setError: (message: string | null) => void;
};

type Canvases = Map<HTMLCanvasElement, boolean>;

function mergeTiles(
  current: VideoTile[],
  peers: PeerTracks[],
  replace: boolean,
) {
  const kept = replace
    ? []
    : current.filter(
        (tile) =>
          !peers.some(
            (peer) =>
              peer.peerIndex === tile.peerIndex && peer.epoch === tile.epoch,
          ),
      );
  const added = peers.flatMap((peer) =>
    peer.tracks.map((track) => ({
      key: tileKey(peer.peerIndex, peer.epoch, track.track),
      peerIndex: peer.peerIndex,
      epoch: peer.epoch,
      pubkey: peer.pubkey,
      track: track.track,
    })),
  );
  return [...kept, ...added];
}

/** The most recently bound canvas wins while a tile moves between layouts. */
function latestCanvas(views: Map<string, Canvases>, key: string) {
  const canvases = views.get(key);
  if (!canvases || canvases.size === 0) return null;
  return [...canvases.keys()].at(-1) ?? null;
}

export function useVideoConnection({
  enabled,
  linkRef,
  requestKey,
  onLinkOpen,
  release,
  setError,
}: Args) {
  const [tiles, setTiles] = React.useState<VideoTile[]>([]);
  const [linkState, setLinkState] = React.useState<LinkState>("idle");
  const [stalled, setStalled] = React.useState<ReadonlySet<string>>(new Set());
  const tilesRef = React.useRef(tiles);
  const views = React.useRef(new Map<string, Canvases>());
  const sent = React.useRef(new Map<string, number | null>());
  const decoders = React.useRef(new Map<string, TileDecoder>());
  const supervisor = React.useRef<ReturnType<
    typeof createLinkSupervisor
  > | null>(null);
  const onLinkOpenRef = React.useRef(onLinkOpen);
  onLinkOpenRef.current = onLinkOpen;

  const markStalled = React.useCallback((key: string, value: boolean) => {
    setStalled((current) => {
      if (current.has(key) === value) return current;
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const sync = React.useCallback(
    (force?: string) => {
      const summary = new Map<string, TileView>();
      for (const [key, canvases] of views.current) {
        if (canvases.size > 0) {
          summary.set(key, { large: [...canvases.values()].some(Boolean) });
        }
      }
      const current = tilesRef.current;
      const plan = planSubscriptions(current, summary);
      for (const tile of current) {
        const layer = plan.get(tile.key) ?? null;
        if (layer !== null && !decoders.current.has(tile.key)) {
          const decoder = createTileDecoder({
            stallMs: tile.track === TRACK_SCREEN ? 4000 : 2500,
            onStall: (value) => markStalled(tile.key, value),
            requestKeyframe: () => sync(tile.key),
          });
          decoder.attach(latestCanvas(views.current, tile.key));
          decoders.current.set(tile.key, decoder);
        }
        if (layer === null && decoders.current.has(tile.key)) {
          decoders.current.get(tile.key)?.close();
          decoders.current.delete(tile.key);
          markStalled(tile.key, false);
        }
        const unchanged = sent.current.get(tile.key) === layer;
        if (unchanged && force !== tile.key) continue;
        if (!sent.current.has(tile.key) && layer === null) continue;
        linkRef.current.subscribe(
          tile.peerIndex,
          tile.epoch,
          tile.track,
          layer,
        );
        sent.current.set(tile.key, layer);
      }
      const live = new Set(current.map((tile) => tile.key));
      for (const key of [...sent.current.keys()]) {
        if (!live.has(key)) sent.current.delete(key);
      }
      for (const [key, decoder] of [...decoders.current]) {
        if (live.has(key)) continue;
        decoder.close();
        decoders.current.delete(key);
        markStalled(key, false);
      }
    },
    [linkRef, markStalled],
  );

  const applyPeers = React.useCallback(
    (peers: PeerTracks[], replace: boolean) => {
      const next = mergeTiles(tilesRef.current, peers, replace);
      tilesRef.current = next;
      setTiles(next);
      sync();
    },
    [sync],
  );

  const reset = React.useCallback(() => {
    tilesRef.current = [];
    setTiles([]);
    sent.current.clear();
    for (const decoder of decoders.current.values()) decoder.close();
    decoders.current.clear();
    setStalled(new Set());
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    const sup = createLinkSupervisor({
      open: (onClose) =>
        openVideoLink(
          {
            onPeers: (peers) => applyPeers(peers, true),
            onDelta: (peer) => applyPeers([peer], false),
            onKeyframe: (track, layer) => requestKey(track, layer),
            onError: (code) => {
              setError(videoErrorText(code));
              if (TERMINAL_ERRORS.has(code)) sup.fail();
            },
            onFrame: (frame) => {
              decoders.current
                .get(tileKey(frame.peerIndex, frame.epoch, frame.track))
                ?.push(frame.keyframe, frame.timestamp, frame.annexB);
            },
          },
          onClose,
        ),
      onChange: (state, link) => {
        linkRef.current = link;
        setLinkState(state);
        if (state === "open") {
          // The relay forgot everything with the old socket.
          sent.current.clear();
          sync();
          onLinkOpenRef.current(link);
        }
        // Keep tiles through a reconnect (the relay's snapshot replaces them
        // on open) so the stage and its status stay visible; drop them only
        // when video is given up.
        if (state === "failed") reset();
      },
    });
    supervisor.current = sup;
    const unlisten = listen<{ phase?: string }>(
      "huddle-state-changed",
      (event) => {
        const phase = event.payload.phase;
        if (phase === "idle" || phase === "leaving") {
          sup.stop();
          release();
          reset();
          setError(null);
        }
        if (phase === "active" || phase === "connected") sup.start();
      },
    );
    void invoke<{ phase?: string }>("get_huddle_state")
      .then((state) => {
        if (state?.phase === "active" || state?.phase === "connected")
          sup.start();
      })
      .catch(() => undefined);
    return () => {
      sup.stop();
      supervisor.current = null;
      release();
      reset();
      void unlisten.then((stop) => stop());
    };
  }, [
    applyPeers,
    enabled,
    linkRef,
    release,
    requestKey,
    reset,
    setError,
    sync,
  ]);

  /** Register a rendered canvas for a tile; returns its cleanup. */
  const bindTile = React.useCallback(
    (key: string, canvas: HTMLCanvasElement | null, large: boolean) => {
      if (!canvas) return () => undefined;
      let canvases = views.current.get(key);
      if (!canvases) {
        canvases = new Map();
        views.current.set(key, canvases);
      }
      canvases.delete(canvas);
      canvases.set(canvas, large);
      decoders.current.get(key)?.attach(canvas);
      sync();
      return () => {
        const owned = views.current.get(key);
        if (!owned?.delete(canvas)) return;
        if (owned.size === 0) views.current.delete(key);
        decoders.current.get(key)?.attach(latestCanvas(views.current, key));
        sync();
      };
    },
    [sync],
  );

  const retry = React.useCallback(() => {
    setError(null);
    supervisor.current?.retry();
  }, [setError]);

  return { tiles, linkState, stalled, bindTile, retry };
}
