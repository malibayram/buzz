import * as React from "react";

import {
  TRACK_CAMERA,
  TRACK_SCREEN,
  cameraLayers,
  screenLayer,
  type LayerSpec,
} from "./protocol";
import { startEncode, videoCodecsSupported } from "./videoEncoder";
import type { VideoLink } from "./videoTransport";

const CAMERA_KEYFRAME_MS = 3000;
const CAMERA_STORAGE_KEY = "buzz.huddle.cameraDeviceId";

function readCamera(): string {
  try {
    return window.localStorage.getItem(CAMERA_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
const SCREEN_KEYFRAME_MS = 6000;

type Capture = {
  supported: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  cameraDevices: MediaDeviceInfo[];
  cameraDeviceId: string;
  setCameraDeviceId: (id: string) => void;
  toggleCamera: () => void;
  toggleScreen: () => void;
  /** Re-announce live tracks on a fresh link (after a reconnect). */
  republish: (link: VideoLink) => void;
  release: () => void;
};

type Active = {
  stop: () => void;
  layers: LayerSpec[];
};

type Args = {
  linkRef: React.RefObject<VideoLink>;
  wantsKey: (track: number, layer: number) => boolean;
  requestKey: (track: number, layer: number) => void;
  setError: (message: string | null) => void;
};

/**
 * WebKit stops advancing a `<video>` that is not in the document, so the
 * encoder's source sits in the DOM, invisible and inert.
 */
function mountSource(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  video.srcObject = stream;
  document.body.appendChild(video);
  void video.play().catch(() => undefined);
  return video;
}

function sourceSize(track: MediaStreamTrack | undefined) {
  const settings = track?.getSettings() ?? {};
  return { width: settings.width ?? 1280, height: settings.height ?? 720 };
}

function useCameraDevices() {
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const refresh = React.useCallback(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === "videoinput")))
      .catch(() => undefined);
  }, []);
  React.useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);
  return { devices, refresh };
}

export function useLocalCapture({
  linkRef,
  wantsKey,
  requestKey,
  setError,
}: Args): Capture {
  const supported = React.useMemo(videoCodecsSupported, []);
  const [localCamera, setLocalCamera] = React.useState<MediaStream | null>(
    null,
  );
  const [localScreen, setLocalScreen] = React.useState<MediaStream | null>(
    null,
  );
  const [cameraDeviceId, setCameraDeviceIdState] = React.useState(readCamera);
  const { devices: cameraDevices, refresh } = useCameraDevices();
  const camera = React.useRef<Active | null>(null);
  const screen = React.useRef<Active | null>(null);
  // Fences async getUserMedia results against a toggle-off or release.
  const cameraGen = React.useRef(0);
  const screenGen = React.useRef(0);

  const encodeInto = React.useCallback(
    (
      video: HTMLVideoElement,
      track: number,
      layers: LayerSpec[],
      every: number,
    ) =>
      startEncode({
        source: video,
        track,
        layers,
        sink: (bytes) => linkRef.current.sendFrame(bytes),
        backlog: () => linkRef.current.backlog(),
        wantsKey,
        keyframeEveryMs: every,
      }),
    [linkRef, wantsKey],
  );

  const stopCamera = React.useCallback(() => {
    cameraGen.current += 1;
    if (!camera.current) return;
    camera.current.stop();
    camera.current = null;
    linkRef.current.unpublish(TRACK_CAMERA);
    setLocalCamera(null);
  }, [linkRef]);

  const startCamera = React.useCallback(
    (deviceId: string) => {
      if (!supported) {
        setError("Video isn't supported in this app on your system");
        return;
      }
      const mine = ++cameraGen.current;
      const video: MediaTrackConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      };
      if (deviceId) video.deviceId = { exact: deviceId };
      void navigator.mediaDevices
        .getUserMedia({ video, audio: false })
        .then((stream) => {
          if (mine !== cameraGen.current) {
            for (const track of stream.getTracks()) track.stop();
            return;
          }
          const track = stream.getVideoTracks()[0];
          const { width, height } = sourceSize(track);
          const layers = cameraLayers(width, height);
          const source = mountSource(stream);
          requestKey(TRACK_CAMERA, 0);
          requestKey(TRACK_CAMERA, 1);
          linkRef.current.publishCamera(layers);
          const stopEncode = encodeInto(
            source,
            TRACK_CAMERA,
            layers,
            CAMERA_KEYFRAME_MS,
          );
          camera.current = {
            layers,
            stop: () => {
              stopEncode();
              source.remove();
              for (const item of stream.getTracks()) item.stop();
            },
          };
          track?.addEventListener("ended", () => {
            if (camera.current === null || mine !== cameraGen.current) return;
            stopCamera();
            setError("Your camera was disconnected");
          });
          setLocalCamera(stream);
          setError(null);
          refresh();
        })
        .catch((err: unknown) => {
          if (mine !== cameraGen.current) return;
          setError(err instanceof Error ? err.message : "Camera failed");
        });
    },
    [encodeInto, linkRef, refresh, requestKey, setError, stopCamera, supported],
  );

  const toggleCamera = React.useCallback(() => {
    if (camera.current) stopCamera();
    else startCamera(cameraDeviceId);
  }, [cameraDeviceId, startCamera, stopCamera]);

  const setCameraDeviceId = React.useCallback(
    (id: string) => {
      setCameraDeviceIdState(id);
      try {
        window.localStorage.setItem(CAMERA_STORAGE_KEY, id);
      } catch {
        /* per-viewer convenience only */
      }
      if (camera.current) {
        stopCamera();
        startCamera(id);
      }
    },
    [startCamera, stopCamera],
  );

  const stopScreen = React.useCallback(() => {
    screenGen.current += 1;
    if (!screen.current) return;
    screen.current.stop();
    screen.current = null;
    linkRef.current.unpublish(TRACK_SCREEN);
    setLocalScreen(null);
  }, [linkRef]);

  const toggleScreen = React.useCallback(() => {
    if (screen.current) {
      stopScreen();
      return;
    }
    if (!supported) {
      setError("Screen sharing isn't supported in this app on your system");
      return;
    }
    const mine = ++screenGen.current;
    void navigator.mediaDevices
      .getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 15 } },
        audio: false,
      })
      .then((stream) => {
        if (mine !== screenGen.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const track = stream.getVideoTracks()[0];
        if (track) track.contentHint = "detail";
        const { width, height } = sourceSize(track);
        const layer = screenLayer(width, height);
        const source = mountSource(stream);
        requestKey(TRACK_SCREEN, 0);
        linkRef.current.publishScreen(layer);
        const stopEncode = encodeInto(
          source,
          TRACK_SCREEN,
          [layer],
          SCREEN_KEYFRAME_MS,
        );
        screen.current = {
          layers: [layer],
          stop: () => {
            stopEncode();
            source.remove();
            for (const item of stream.getTracks()) item.stop();
          },
        };
        track?.addEventListener("ended", () => {
          if (mine === screenGen.current) stopScreen();
        });
        setLocalScreen(stream);
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine !== screenGen.current) return;
        // Dismissing the picker is a choice, not an error.
        if (err instanceof DOMException && err.name === "NotAllowedError")
          return;
        setError(err instanceof Error ? err.message : "Screen share failed");
      });
  }, [encodeInto, linkRef, requestKey, setError, stopScreen, supported]);

  const republish = React.useCallback(
    (link: VideoLink) => {
      if (camera.current) {
        requestKey(TRACK_CAMERA, 0);
        requestKey(TRACK_CAMERA, 1);
        link.publishCamera(camera.current.layers);
      }
      const shared = screen.current?.layers[0];
      if (shared) {
        requestKey(TRACK_SCREEN, 0);
        link.publishScreen(shared);
      }
    },
    [requestKey],
  );

  const release = React.useCallback(() => {
    stopCamera();
    stopScreen();
  }, [stopCamera, stopScreen]);

  return {
    supported,
    cameraOn: localCamera != null,
    screenOn: localScreen != null,
    localCamera,
    localScreen,
    cameraDevices,
    cameraDeviceId,
    setCameraDeviceId,
    toggleCamera,
    toggleScreen,
    republish,
    release,
  };
}
