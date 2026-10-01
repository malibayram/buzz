import * as React from "react";

import { TRACK_SCREEN } from "./protocol";
import { useHuddleVideo, type VideoTile } from "./useHuddleVideo";

export function VideoStage() {
  const video = useHuddleVideo();
  if (!video.enabled) return null;
  const visible =
    video.localCamera != null ||
    video.localScreen != null ||
    video.tiles.length > 0;
  if (!visible) return null;
  const screen = video.tiles.find((tile) => tile.track === TRACK_SCREEN);
  const cameras = video.tiles.filter((tile) => tile.track !== TRACK_SCREEN);
  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-0 bottom-(--buzz-huddle-drawer-height) z-[3] flex min-h-0 flex-col gap-2 bg-background/80 p-3"
      data-testid="huddle-video-stage"
    >
      {video.localScreen ? (
        <StreamView
          label="Your screen"
          stream={video.localScreen}
          testId="huddle-screen-spotlight"
        />
      ) : null}
      {screen ? <RemoteTile spotlight tile={screen} /> : null}
      <div className="flex min-h-0 flex-1 flex-wrap gap-2">
        {video.localCamera ? (
          <StreamView
            label="Your camera"
            stream={video.localCamera}
            testId="huddle-local-camera"
          />
        ) : null}
        {cameras.map((tile) => (
          <RemoteTile
            key={tile.key}
            spotlight={video.spotlightKey === tile.key}
            tile={tile}
          />
        ))}
      </div>
    </div>
  );
}

function StreamView({
  stream,
  testId,
  label,
}: {
  stream: MediaStream;
  testId: string;
  label: string;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      aria-label={label}
      autoPlay
      className="max-h-full min-h-0 w-full flex-1 rounded-md bg-black object-contain"
      data-testid={testId}
      muted
      playsInline
      ref={ref}
    />
  );
}

function RemoteTile({
  tile,
  spotlight,
}: {
  tile: VideoTile;
  spotlight: boolean;
}) {
  const { bindTile, focusTile } = useHuddleVideo();
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    bindTile(tile.key, ref.current);
    return () => bindTile(tile.key, null);
  }, [bindTile, tile.key]);
  const label = tile.track === TRACK_SCREEN ? "Shared screen" : "Show camera";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={spotlight}
      className="min-h-16 min-w-24 flex-1 overflow-hidden rounded-md bg-black"
      data-testid={
        tile.track === TRACK_SCREEN
          ? "huddle-screen-spotlight"
          : "huddle-video-tile"
      }
      onClick={() => focusTile(tile.key)}
    >
      <canvas className="h-full w-full" ref={ref} />
    </button>
  );
}
