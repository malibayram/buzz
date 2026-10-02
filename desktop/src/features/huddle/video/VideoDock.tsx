import { ChevronDown, ChevronUp, ExternalLink, Video } from "lucide-react";
import * as React from "react";

import { ParticipantTile } from "./ParticipantTile";
import { dockTile } from "./stageLayout";
import { useHuddleVideo } from "./useHuddleVideo";
import { useStageModel } from "./useStageModel";
import { LinkStatus, PresentingBanner, useHasVideo } from "./VideoStage";

/**
 * Picture-in-picture for the main window, top-right so it never covers the
 * composer: the shared screen, else the pinned
 * or speaking person. Only the shown tile is subscribed, so a minimized call
 * costs one video stream.
 */
export function VideoDock({ onExpand }: { onExpand?: () => void }) {
  const video = useHuddleVideo();
  const hasVideo = useHasVideo();
  const { tiles, personFor, isSpeaking, speakerList } = useStageModel();
  const [collapsed, setCollapsed] = React.useState(false);
  if (!hasVideo) return null;
  const tile = dockTile({
    tiles,
    pinnedKey: video.pinnedKey,
    activeSpeakers: speakerList,
  });
  const videoCount = tiles.filter((t) => t.kind !== "avatar").length;
  return (
    <section
      aria-label="Huddle video"
      className="pointer-events-auto absolute top-28 right-4 z-20 flex w-80 flex-col gap-2 rounded-xl border border-border bg-background/95 p-2 shadow-lg backdrop-blur"
      data-testid="huddle-video-dock"
    >
      <div className="flex items-center gap-1">
        <Video aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">
          {videoCount === 1 ? "1 video" : `${videoCount} videos`}
        </span>
        <LinkStatus />
        <div className="ml-auto flex items-center">
          {onExpand ? (
            <button
              aria-label="Open huddle window"
              className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted"
              data-testid="huddle-video-dock-expand"
              onClick={onExpand}
              type="button"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Show video" : "Hide video"}
            className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted"
            onClick={() => setCollapsed((value) => !value)}
            type="button"
          >
            {collapsed ? (
              <ChevronUp aria-hidden="true" className="size-4" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <>
          <PresentingBanner compact />
          {tile ? (
            <ParticipantTile
              className="aspect-video w-full"
              fit={tile.kind === "screen" ? "contain" : "cover"}
              large={false}
              person={personFor(tile.pubkey)}
              speaking={isSpeaking(tile.pubkey)}
              tile={tile}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
