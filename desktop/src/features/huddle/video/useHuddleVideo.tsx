import * as React from "react";

import { useFeatureEnabled } from "@/shared/features";
import type { VideoTile } from "./protocol";
import { useLocalCapture } from "./videoCapture";
import type { TileDecoder } from "./videoDecoder";
import { noopVideoLink, type VideoLink } from "./videoTransport";
import { useVideoConnection } from "./useVideoConnection";

export type { VideoTile };

type VideoApi = {
  enabled: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  error: string | null;
  tiles: VideoTile[];
  spotlightKey: string | null;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  toggleCamera: () => void;
  toggleScreen: () => void;
  focusTile: (key: string) => void;
  bindTile: (key: string, node: HTMLCanvasElement | null) => void;
};

const VideoContext = React.createContext<VideoApi | null>(null);

export function HuddleVideoProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = useVideoSession(useFeatureEnabled("huddleVideo"));
  return (
    <VideoContext.Provider value={value}>{children}</VideoContext.Provider>
  );
}

export function useHuddleVideo(): VideoApi {
  const value = React.useContext(VideoContext);
  if (!value) throw new Error("Huddle video is unavailable");
  return value;
}

function useVideoSession(enabled: boolean): VideoApi {
  const [error, setError] = React.useState<string | null>(null);
  const linkRef = React.useRef<VideoLink>(noopVideoLink());
  const keysRef = React.useRef(new Set<string>());
  const decoders = React.useRef(new Map<string, TileDecoder>());
  const wantsKey = React.useCallback((track: number, layer: number) => {
    const id = `${track}:${layer}`;
    const hit = keysRef.current.has(id);
    keysRef.current.delete(id);
    return hit;
  }, []);
  const requestKey = React.useCallback((track: number, layer: number) => {
    keysRef.current.add(`${track}:${layer}`);
  }, []);
  const local = useLocalCapture(linkRef, wantsKey, requestKey, setError);
  const connection = useVideoConnection({
    enabled,
    linkRef,
    keysRef,
    decoders,
    release: local.release,
    setError,
  });
  const focusTile = (key: string) => {
    connection.setSpotlightKey(key);
    connection.syncSubs(connection.tilesRef.current, key);
  };
  return {
    enabled,
    error,
    tiles: connection.tiles,
    spotlightKey: connection.spotlightKey,
    focusTile,
    bindTile: connection.bindTile,
    cameraOn: local.cameraOn,
    screenOn: local.screenOn,
    localCamera: local.localCamera,
    localScreen: local.localScreen,
    toggleCamera: local.toggleCamera,
    toggleScreen: local.toggleScreen,
  };
}
