import { invoke } from "@tauri-apps/api/core";
import * as React from "react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { useFeatureEnabled } from "@/shared/features";
import type { LinkState } from "./linkSupervisor";
import { TRACK_SCREEN, type VideoTile } from "./protocol";
import { nextScreenSharePin } from "./screenSharePin";
import { useStageFullscreen } from "./useStageFullscreen";
import { useLocalCapture } from "./videoCapture";
import { noopVideoLink, type VideoLink } from "./videoTransport";
import { useVideoConnection } from "./useVideoConnection";

export type { VideoTile };
export type LayoutPreference = "auto" | "grid" | "speaker";

type VideoApi = {
  enabled: boolean;
  /** WebCodecs exist here; without them camera and screen stay off. */
  supported: boolean;
  linkState: LinkState;
  retry: () => void;
  cameraOn: boolean;
  screenOn: boolean;
  error: string | null;
  clearError: () => void;
  tiles: VideoTile[];
  stalled: ReadonlySet<string>;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  cameraDevices: MediaDeviceInfo[];
  cameraDeviceId: string;
  setCameraDeviceId: (id: string) => void;
  toggleCamera: () => void;
  toggleScreen: () => void;
  pinnedKey: string | null;
  setPinnedKey: (key: string | null) => void;
  /** The tile shown in OS full screen, if any. */
  fullscreenKey: string | null;
  enterFullscreen: (key: string) => void;
  exitFullscreen: () => void;
  layout: LayoutPreference;
  setLayout: (layout: LayoutPreference) => void;
  bindTile: (
    key: string,
    node: HTMLCanvasElement | null,
    large: boolean,
  ) => () => void;
};

const LAYOUT_STORAGE_KEY = "buzz.huddle.videoLayout";
/** `peer:epoch:track`, as built by `tileKey`. */
const REMOTE_TILE_KEY = /^\d+:\d+:\d+$/;

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

function readLayout(): LayoutPreference {
  try {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === "grid" || stored === "speaker") return stored;
  } catch {
    /* storage unavailable: fall back to auto */
  }
  return "auto";
}

/**
 * When a new screen share starts in a quiet huddle it takes the stage once; a
 * share that starts while another screen is showing waits in the strip (see
 * `nextScreenSharePin`). A pin the viewer sets survives later roster and track
 * changes. Your own share never reaches your stage, so it is ignored here.
 */
function useScreenSharePin(tiles: VideoTile[], selfPubkey: string | null) {
  const [pinnedKey, setPinnedKey] = React.useState<string | null>(null);
  const seenScreens = React.useRef<string[]>([]);
  React.useEffect(() => {
    const self = selfPubkey?.toLowerCase();
    const screens = tiles
      .filter(
        (tile) =>
          tile.track === TRACK_SCREEN && tile.pubkey.toLowerCase() !== self,
      )
      .map((tile) => tile.key);
    const previousScreens = seenScreens.current;
    seenScreens.current = screens;
    setPinnedKey((current) =>
      nextScreenSharePin({ previousScreens, screens, pinnedKey: current }),
    );
  }, [selfPubkey, tiles]);
  React.useEffect(() => {
    // Only a remote video tile can vanish under a pin; people and the local
    // camera stay on the stage as avatars when their video stops.
    if (!pinnedKey || !REMOTE_TILE_KEY.test(pinnedKey)) return;
    if (!tiles.some((tile) => tile.key === pinnedKey)) setPinnedKey(null);
  }, [pinnedKey, tiles]);
  return { pinnedKey, setPinnedKey };
}

type VideoHandoff = { camera: boolean; screen: boolean };

/**
 * Video moves between the drawer and the room window with the huddle. The
 * window giving it up records what was live; the one taking it over turns the
 * camera back on (a screen share needs a fresh picker, so it asks instead).
 */
function useVideoHandoff(
  local: ReturnType<typeof useLocalCapture>,
  setError: (message: string | null) => void,
) {
  const live = React.useRef({ camera: false, screen: false });
  live.current = { camera: local.cameraOn, screen: local.screenOn };
  const localRef = React.useRef(local);
  localRef.current = local;
  const checked = React.useRef(false);
  React.useEffect(
    () => () => {
      const { camera, screen } = live.current;
      if (!camera && !screen) return;
      void invoke("set_huddle_video_handoff", {
        handoff: { camera, screen } satisfies VideoHandoff,
      }).catch(() => undefined);
    },
    [],
  );
  return React.useCallback(
    (link: VideoLink) => {
      localRef.current.republish(link);
      if (checked.current) return;
      checked.current = true;
      void invoke<VideoHandoff>("take_huddle_video_handoff")
        .then((handoff) => {
          if (handoff.camera && !live.current.camera) {
            localRef.current.toggleCamera();
          }
          if (handoff.screen) {
            setError(
              "Screen sharing stopped when the huddle moved windows. Share again to continue.",
            );
          }
        })
        .catch(() => undefined);
    },
    [setError],
  );
}

function useVideoSession(enabled: boolean): VideoApi {
  const [error, setError] = React.useState<string | null>(null);
  const [layout, setLayoutState] = React.useState(readLayout);
  const linkRef = React.useRef<VideoLink>(noopVideoLink());
  const keysRef = React.useRef(new Set<string>());
  const wantsKey = React.useCallback((track: number, layer: number) => {
    const id = `${track}:${layer}`;
    const hit = keysRef.current.has(id);
    keysRef.current.delete(id);
    return hit;
  }, []);
  const requestKey = React.useCallback((track: number, layer: number) => {
    keysRef.current.add(`${track}:${layer}`);
  }, []);
  const local = useLocalCapture({ linkRef, wantsKey, requestKey, setError });
  const onLinkOpen = useVideoHandoff(local, setError);
  const connection = useVideoConnection({
    enabled,
    linkRef,
    requestKey,
    onLinkOpen,
    release: local.release,
    setError,
  });
  const identity = useIdentityQuery();
  const { pinnedKey, setPinnedKey } = useScreenSharePin(
    connection.tiles,
    identity.data?.pubkey ?? null,
  );
  const fullscreen = useStageFullscreen(connection.tiles);
  const setLayout = React.useCallback((next: LayoutPreference) => {
    setLayoutState(next);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      /* per-viewer convenience only */
    }
  }, []);
  const clearError = React.useCallback(() => setError(null), []);
  return {
    enabled,
    supported: local.supported,
    linkState: connection.linkState,
    retry: connection.retry,
    error,
    clearError,
    tiles: connection.tiles,
    stalled: connection.stalled,
    bindTile: connection.bindTile,
    cameraOn: local.cameraOn,
    screenOn: local.screenOn,
    localCamera: local.localCamera,
    localScreen: local.localScreen,
    cameraDevices: local.cameraDevices,
    cameraDeviceId: local.cameraDeviceId,
    setCameraDeviceId: local.setCameraDeviceId,
    toggleCamera: local.toggleCamera,
    toggleScreen: local.toggleScreen,
    pinnedKey,
    setPinnedKey,
    fullscreenKey: fullscreen.fullscreenKey,
    enterFullscreen: fullscreen.enterFullscreen,
    exitFullscreen: fullscreen.exitFullscreen,
    layout,
    setLayout,
  };
}
