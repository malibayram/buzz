import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as React from "react";

import { openTileDecoder, type TileDecoder } from "./videoDecoder";
import {
  TRACK_SCREEN,
  tileKey,
  videoErrorText,
  type PeerTracks,
  type VideoTile,
} from "./protocol";
import { noopVideoLink, openVideoLink, type VideoLink } from "./videoTransport";

type Args = {
  enabled: boolean;
  linkRef: React.RefObject<VideoLink>;
  keysRef: React.RefObject<Set<string>>;
  decoders: React.RefObject<Map<string, TileDecoder>>;
  release: () => void;
  setError: (message: string | null) => void;
};

export function useVideoConnection({
  enabled,
  linkRef,
  keysRef,
  decoders,
  release,
  setError,
}: Args) {
  const [tiles, setTiles] = React.useState<VideoTile[]>([]);
  const [spotlightKey, setSpotlightKey] = React.useState<string | null>(null);
  const tilesRef = React.useRef(tiles);
  tilesRef.current = tiles;
  const spotlightRef = React.useRef(spotlightKey);
  spotlightRef.current = spotlightKey;
  const syncSubs = React.useCallback(
    (next: VideoTile[], spotlight: string | null) => {
      for (const tile of next) {
        const layer =
          tile.track === TRACK_SCREEN ? 0 : tile.key === spotlight ? 1 : 0;
        linkRef.current.subscribe(
          tile.peerIndex,
          tile.epoch,
          tile.track,
          layer,
        );
      }
    },
    [linkRef],
  );
  const applyPeers = React.useCallback(
    (peers: PeerTracks[], replace: boolean) => {
      setTiles((current) => {
        const kept = replace
          ? []
          : current.filter(
              (tile) =>
                !peers.some(
                  (peer) =>
                    peer.peerIndex === tile.peerIndex &&
                    peer.epoch === tile.epoch,
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
        const next = [...kept, ...added];
        const screen = next.find((tile) => tile.track === TRACK_SCREEN);
        const spotlight = screen?.key ?? spotlightRef.current;
        const visible =
          spotlight && next.some((tile) => tile.key === spotlight)
            ? spotlight
            : null;
        if (screen) setSpotlightKey(screen.key);
        syncSubs(next, visible);
        return next;
      });
    },
    [syncSubs],
  );

  const generationRef = React.useRef(0);
  React.useEffect(() => {
    if (!enabled) return;
    const generation = ++generationRef.current;
    const alive = () => generationRef.current === generation;
    let closed = false;
    let opening = false;
    const connect = () => {
      if (!alive() || closed || opening) return;
      opening = true;
      void openVideoLink(
        {
          onPeers: (peers) => applyPeers(peers, true),
          onDelta: (peer) => applyPeers([peer], false),
          onKeyframe: (track, layer) =>
            keysRef.current.add(`${track}:${layer}`),
          onError: (code) => setError(videoErrorText(code)),
          onFrame: (frame) => {
            const key = tileKey(frame.peerIndex, frame.epoch, frame.track);
            decoders.current
              .get(key)
              ?.push(frame.keyframe, frame.timestamp, frame.annexB);
          },
        },
        alive,
      )
        .then((link) => {
          if (!alive() || closed) {
            link.close();
            return;
          }
          linkRef.current = link;
          syncSubs(tilesRef.current, spotlightRef.current);
        })
        .catch((err: unknown) => {
          if (alive())
            setError(err instanceof Error ? err.message : "Video failed");
        });
    };
    const unlisten = listen<{ phase?: string }>(
      "huddle-state-changed",
      (event) => {
        const phase = event.payload.phase;
        if (phase === "idle" || phase === "leaving") {
          closed = true;
          opening = false;
          linkRef.current.close();
          linkRef.current = noopVideoLink();
          release();
          setTiles([]);
          setSpotlightKey(null);
          return;
        }
        if (phase === "active" || phase === "connected") {
          closed = false;
          connect();
        }
      },
    );
    void invoke<{ phase?: string }>("get_huddle_state").then((state) => {
      if (state?.phase === "active" || state?.phase === "connected") connect();
    });
    return () => {
      generationRef.current += 1;
      linkRef.current.close();
      release();
      void unlisten.then((stop) => stop());
    };
  }, [
    applyPeers,
    decoders,
    enabled,
    keysRef,
    linkRef,
    release,
    setError,
    syncSubs,
  ]);

  const bindTile = React.useCallback(
    (key: string, node: HTMLCanvasElement | null) => {
      const existing = decoders.current.get(key);
      if (!node) {
        existing?.close();
        decoders.current.delete(key);
        return;
      }
      if (existing) return;
      decoders.current.set(key, openTileDecoder(node));
    },
    [decoders],
  );

  return { tiles, spotlightKey, setSpotlightKey, syncSubs, tilesRef, bindTile };
}
