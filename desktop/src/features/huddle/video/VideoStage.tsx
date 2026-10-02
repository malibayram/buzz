import {
  Maximize2,
  Minimize2,
  MessageSquareText,
  RotateCw,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { StageGrid, StagePresentation } from "./StageViews";
import type { LayoutPreference } from "./useHuddleVideo";
import { useHuddleVideo } from "./useHuddleVideo";
import { useStageModel } from "./useStageModel";

const LAYOUTS: { value: LayoutPreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "grid", label: "Grid" },
  { value: "speaker", label: "Speaker" },
];

export function useHasVideo() {
  const video = useHuddleVideo();
  return (
    video.enabled &&
    (video.localCamera != null ||
      video.localScreen != null ||
      video.tiles.length > 0)
  );
}

/** "Reconnecting…" / "Disconnected · Retry", or nothing while healthy. */
export function LinkStatus() {
  const { linkState, retry } = useHuddleVideo();
  if (linkState === "reconnecting" || linkState === "connecting") {
    return (
      <output
        className="flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300"
        data-testid="huddle-video-link-status"
      >
        <RotateCw aria-hidden="true" className="size-3 animate-spin" />
        {linkState === "connecting"
          ? "Connecting video…"
          : "Reconnecting video…"}
      </output>
    );
  }
  if (linkState === "failed") {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-xs text-destructive"
        data-testid="huddle-video-link-status"
        role="alert"
      >
        Video disconnected
        <button className="font-medium underline" onClick={retry} type="button">
          Retry
        </button>
      </div>
    );
  }
  return null;
}

/** Your own screen never mirrors back full size; you get this instead. */
export function PresentingBanner({ compact = false }: { compact?: boolean }) {
  const { localScreen, toggleScreen } = useHuddleVideo();
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.srcObject = localScreen;
  }, [localScreen]);
  if (!localScreen) return null;
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 p-2"
      data-testid="huddle-presenting-banner"
    >
      {compact ? null : (
        <video
          autoPlay
          className="h-12 w-20 rounded bg-black object-contain"
          data-testid="huddle-screen-preview"
          muted
          playsInline
          ref={ref}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        You're presenting your screen
      </span>
      <button
        className="rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
        data-testid="huddle-stop-presenting"
        onClick={toggleScreen}
        type="button"
      >
        Stop
      </button>
    </div>
  );
}

/**
 * The room window's video stage. It covers the room surface above the
 * drawer; "Transcript" shrinks it so the bottom-anchored transcript shows.
 */
export function VideoStage() {
  const video = useHuddleVideo();
  const hasVideo = useHasVideo();
  const { model, personFor, isSpeaking } = useStageModel();
  const [showTranscript, setShowTranscript] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  if (!hasVideo) return null;
  const labels = { personFor, isSpeaking };
  return (
    <section
      aria-label="Huddle video"
      className={cn(
        "pointer-events-auto absolute inset-x-0 top-0 z-20 flex min-h-0 flex-col gap-2 bg-background p-3",
        showTranscript
          ? "bottom-[calc(var(--buzz-huddle-drawer-height)+40%)] border-b border-border"
          : "bottom-(--buzz-huddle-drawer-height)",
      )}
      data-testid="huddle-video-stage"
    >
      <div className="flex shrink-0 items-center gap-2">
        <div
          aria-label="Video layout"
          className="flex rounded-md bg-muted p-0.5"
          role="radiogroup"
        >
          {LAYOUTS.map((option) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control styled as buttons
            <button
              aria-checked={video.layout === option.value}
              className={cn(
                "rounded px-2.5 py-1 text-xs",
                video.layout === option.value
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={option.value}
              onClick={() => video.setLayout(option.value)}
              role="radio"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <LinkStatus />
        <div className="ml-auto flex items-center gap-1">
          {model.mode === "presentation" ? (
            <button
              aria-label={focused ? "Show participants" : "Focus on main view"}
              aria-pressed={focused}
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
              onClick={() => setFocused((value) => !value)}
              type="button"
            >
              {focused ? (
                <Minimize2 aria-hidden="true" className="size-4" />
              ) : (
                <Maximize2 aria-hidden="true" className="size-4" />
              )}
            </button>
          ) : null}
          <button
            aria-pressed={showTranscript}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-muted aria-pressed:bg-muted"
            data-testid="huddle-stage-transcript-toggle"
            onClick={() => setShowTranscript((value) => !value)}
            type="button"
          >
            <MessageSquareText aria-hidden="true" className="size-4" />
            Transcript
          </button>
        </div>
      </div>
      <PresentingBanner />
      {model.mode === "grid" ? (
        <StageGrid labels={labels} model={model} />
      ) : (
        <StagePresentation focused={focused} labels={labels} model={model} />
      )}
    </section>
  );
}
