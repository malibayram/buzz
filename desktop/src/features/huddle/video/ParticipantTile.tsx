import { Loader2, Pin, PinOff } from "lucide-react";
import * as React from "react";

import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { cn } from "@/shared/lib/cn";
import type { StageTile } from "./stageLayout";
import { useHuddleVideo } from "./useHuddleVideo";
import type { StagePerson } from "./useStageRoster";

type TileProps = {
  tile: StageTile;
  person: StagePerson;
  speaking: boolean;
  large: boolean;
  /** Main stage and screens letterbox; grid and strip tiles crop to fill. */
  fit: "cover" | "contain";
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

function RemoteCanvas({
  tileKey,
  large,
  fit,
}: {
  tileKey: string;
  large: boolean;
  fit: "cover" | "contain";
}) {
  const { bindTile } = useHuddleVideo();
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(
    () => bindTile(tileKey, ref.current, large),
    [bindTile, large, tileKey],
  );
  return (
    <canvas
      className={cn(
        "absolute inset-0 h-full w-full",
        fit === "cover" ? "object-cover" : "object-contain",
      )}
      ref={ref}
    />
  );
}

function LocalVideo({
  stream,
  fit,
}: {
  stream: MediaStream;
  fit: "cover" | "contain";
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      autoPlay
      className={cn(
        "absolute inset-0 h-full w-full -scale-x-100",
        fit === "cover" ? "object-cover" : "object-contain",
      )}
      data-testid="huddle-local-camera"
      muted
      playsInline
      ref={ref}
    />
  );
}

function tileLabel(tile: StageTile, person: StagePerson, speaking: boolean) {
  const name = tile.isSelf ? `${person.displayName} (you)` : person.displayName;
  if (tile.kind === "screen") return `${person.displayName}'s screen`;
  const parts = [name, tile.kind === "camera" ? "camera on" : "camera off"];
  if (speaking) parts.push("speaking");
  return parts.join(", ");
}

/**
 * One person or screen on the stage. The tile itself is a labelled group;
 * its only control is the pin button, so each action has one owner.
 */
export function ParticipantTile({
  tile,
  person,
  speaking,
  large,
  fit,
  compact = false,
  className,
  style,
}: TileProps) {
  const video = useHuddleVideo();
  const pinned = video.pinnedKey === tile.key;
  const stalled = video.stalled.has(tile.key);
  const showVideo =
    tile.kind !== "avatar" && !(tile.isSelf && !video.localCamera);
  const name = tile.isSelf ? `${person.displayName} (you)` : person.displayName;
  const togglePin = () => video.setPinnedKey(pinned ? null : tile.key);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of media plus one pin control
    <div
      aria-label={tileLabel(tile, person, speaking)}
      className={cn(
        "group/tile relative overflow-hidden rounded-lg bg-neutral-900 text-white",
        "ring-offset-2 ring-offset-background transition-shadow",
        speaking && tile.kind !== "screen" && "ring-2 ring-green-500",
        className,
      )}
      data-testid={
        tile.kind === "screen" ? "huddle-screen-tile" : "huddle-video-tile"
      }
      data-tile-key={tile.key}
      onDoubleClick={togglePin}
      role="group"
      style={style}
    >
      {showVideo && tile.remote ? (
        <RemoteCanvas fit={fit} large={large} tileKey={tile.key} />
      ) : null}
      {showVideo && tile.isSelf && video.localCamera ? (
        <LocalVideo fit={fit} stream={video.localCamera} />
      ) : null}
      {!showVideo || stalled ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted">
          <ProfileAvatar
            avatarUrl={person.avatarUrl}
            className={cn(compact ? "size-10" : large ? "size-24" : "size-16")}
            initialsLabel={person.initialsLabel}
            label={person.displayName}
            shape={person.isAgent ? "squircle" : "circle"}
          />
          {stalled ? (
            <span className="flex items-center gap-1 text-2xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              Video paused
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent p-2">
        <span
          className={cn(
            "truncate rounded bg-black/40 px-1.5 py-0.5 font-medium",
            compact ? "text-2xs" : "text-xs",
          )}
        >
          {tile.kind === "screen"
            ? `${person.displayName} is presenting`
            : name}
        </span>
      </div>
      <button
        aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
        aria-pressed={pinned}
        className={cn(
          "absolute inline-flex items-center justify-center rounded-md bg-black/50 text-white transition-opacity",
          compact ? "top-1 right-1 size-6" : "top-2 right-2 size-8",
          "opacity-0 focus-visible:opacity-100 group-hover/tile:opacity-100",
          pinned && "opacity-100",
        )}
        data-testid="huddle-tile-pin"
        onClick={togglePin}
        type="button"
      >
        {pinned ? (
          <PinOff aria-hidden="true" className="size-4" />
        ) : (
          <Pin aria-hidden="true" className="size-4" />
        )}
      </button>
    </div>
  );
}
