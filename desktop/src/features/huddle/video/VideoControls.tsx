import { MonitorUp, Video } from "lucide-react";

import { TRACK_SCREEN } from "./protocol";
import { useHuddleVideo } from "./useHuddleVideo";

export function VideoControls() {
  const video = useHuddleVideo();
  if (!video.enabled) return null;
  const sharing =
    video.screenOn || video.tiles.some((tile) => tile.track === TRACK_SCREEN);
  return (
    <>
      <button
        type="button"
        aria-pressed={video.cameraOn}
        aria-label={video.cameraOn ? "Turn camera off" : "Turn camera on"}
        data-testid="huddle-camera-toggle"
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
        onClick={video.toggleCamera}
      >
        <Video aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-pressed={video.screenOn}
        aria-label={video.screenOn ? "Stop sharing" : "Share screen"}
        data-testid="huddle-screen-toggle"
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
        onClick={video.toggleScreen}
      >
        <MonitorUp aria-hidden="true" className="size-4" />
      </button>
      {sharing ? (
        <span className="text-xs" data-testid="huddle-sharing-indicator">
          Screen is being shared
        </span>
      ) : null}
      {video.error ? (
        <span
          className="max-w-[180px] truncate text-xs text-destructive"
          data-testid="huddle-video-error"
          role="alert"
        >
          {video.error}
        </span>
      ) : null}
    </>
  );
}
