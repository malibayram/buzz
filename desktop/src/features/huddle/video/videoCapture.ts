import * as React from "react";

import { TRACK_CAMERA, TRACK_SCREEN } from "./protocol";
import { startCameraEncode, startScreenEncode } from "./videoEncoder";
import type { VideoLink } from "./videoTransport";

type Capture = {
  cameraOn: boolean;
  screenOn: boolean;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  toggleCamera: () => void;
  toggleScreen: () => void;
  release: () => void;
};

export function useLocalCapture(
  linkRef: React.RefObject<VideoLink>,
  wantsKey: (track: number, layer: number) => boolean,
  requestKey: (track: number, layer: number) => void,
  setError: (message: string | null) => void,
): Capture {
  const [cameraOn, setCameraOn] = React.useState(false);
  const [screenOn, setScreenOn] = React.useState(false);
  const [localCamera, setLocalCamera] = React.useState<MediaStream | null>(
    null,
  );
  const [localScreen, setLocalScreen] = React.useState<MediaStream | null>(
    null,
  );
  const stopCamera = React.useRef<(() => void) | null>(null);
  const stopScreen = React.useRef<(() => void) | null>(null);

  const toggleCamera = React.useCallback(() => {
    if (stopCamera.current) {
      stopCamera.current();
      stopCamera.current = null;
      linkRef.current.unpublish(TRACK_CAMERA);
      setCameraOn(false);
      setLocalCamera(null);
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
      .then((stream) => mountCamera(stream))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Camera failed");
      });

    function mountCamera(stream: MediaStream) {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      void video.play();
      requestKey(0, 0);
      requestKey(0, 1);
      linkRef.current.publishCamera();
      const stopEncode = startCameraEncode(
        video,
        (bytes) => {
          linkRef.current.sendFrame(bytes);
        },
        wantsKey,
      );
      stopCamera.current = () => {
        stopEncode();
        for (const track of stream.getTracks()) track.stop();
      };
      setLocalCamera(stream);
      setCameraOn(true);
      setError(null);
    }
  }, [linkRef, requestKey, setError, wantsKey]);

  const toggleScreen = React.useCallback(() => {
    if (stopScreen.current) {
      stopScreen.current();
      stopScreen.current = null;
      linkRef.current.unpublish(TRACK_SCREEN);
      setScreenOn(false);
      setLocalScreen(null);
      return;
    }
    void navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 15 }, audio: false })
      .then((stream) => mountScreen(stream))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Screen share failed");
      });

    function mountScreen(stream: MediaStream) {
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      void video.play();
      const width = settings.width ?? 1280;
      const height = settings.height ?? 720;
      requestKey(1, 0);
      linkRef.current.publishScreen(width, height);
      const stopEncode = startScreenEncode(
        video,
        width,
        height,
        (bytes) => {
          linkRef.current.sendFrame(bytes);
        },
        wantsKey,
      );
      const stop = () => {
        stopEncode();
        for (const item of stream.getTracks()) item.stop();
      };
      track?.addEventListener("ended", () => {
        stop();
        linkRef.current.unpublish(TRACK_SCREEN);
        setScreenOn(false);
        setLocalScreen(null);
        stopScreen.current = null;
      });
      stopScreen.current = stop;
      setLocalScreen(stream);
      setScreenOn(true);
      setError(null);
    }
  }, [linkRef, requestKey, setError, wantsKey]);

  const release = React.useCallback(() => {
    stopCamera.current?.();
    stopScreen.current?.();
    stopCamera.current = null;
    stopScreen.current = null;
    setCameraOn(false);
    setScreenOn(false);
    setLocalCamera(null);
    setLocalScreen(null);
  }, []);

  return {
    cameraOn,
    screenOn,
    localCamera,
    localScreen,
    toggleCamera,
    toggleScreen,
    release,
  };
}
