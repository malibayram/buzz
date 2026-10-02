import {
  ChevronUp,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
} from "lucide-react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { DeviceList } from "../components/MicControls";
import { TRACK_SCREEN } from "./protocol";
import { useHuddleVideo } from "./useHuddleVideo";

const UNSUPPORTED = "Video isn't available in this app on your system";

function ControlTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="buzz-huddle-tooltip" side="top">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function VideoControls() {
  const video = useHuddleVideo();
  const identity = useIdentityQuery();
  if (!video.enabled) return null;
  const self = identity.data?.pubkey?.toLowerCase();
  const otherSharing =
    !video.screenOn &&
    video.tiles.some(
      (tile) =>
        tile.track === TRACK_SCREEN && tile.pubkey.toLowerCase() !== self,
    );
  const cameraLabel = !video.supported
    ? UNSUPPORTED
    : video.cameraOn
      ? "Turn camera off"
      : "Turn camera on";
  const screenLabel = !video.supported
    ? UNSUPPORTED
    : video.screenOn
      ? "Stop sharing your screen"
      : otherSharing
        ? "Someone else is sharing their screen"
        : "Share your screen";
  const devices = video.cameraDevices.map((device, index) => ({
    id: device.deviceId,
    label: device.label || `Camera ${index + 1}`,
  }));

  return (
    <>
      <Popover>
        <div className="flex items-center rounded-md">
          <ControlTooltip label={cameraLabel}>
            <Button
              aria-disabled={!video.supported}
              aria-label={cameraLabel}
              aria-pressed={video.cameraOn}
              className={cn(
                "h-12 w-auto shrink-0 rounded-r-none px-4 py-4",
                video.cameraOn && "buzz-huddle-split-main",
              )}
              data-testid="huddle-camera-toggle"
              onClick={() => {
                if (video.supported) video.toggleCamera();
              }}
              size="icon"
              variant={video.cameraOn ? "secondary" : "ghost"}
            >
              {video.cameraOn ? (
                <Video aria-hidden="true" className="h-4 w-4" />
              ) : (
                <VideoOff aria-hidden="true" className="h-4 w-4" />
              )}
            </Button>
          </ControlTooltip>
          <PopoverTrigger asChild>
            <Button
              aria-label="Camera settings"
              className="buzz-huddle-split-chevron group h-12 w-auto shrink-0 rounded-l-none px-2 py-4"
              data-testid="huddle-camera-settings"
              size="icon"
              variant="secondary"
            >
              <ChevronUp aria-hidden="true" className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          className="buzz-huddle-drawer buzz-huddle-popover w-64 text-foreground"
          side="top"
        >
          {devices.length > 0 ? (
            <DeviceList
              devices={devices}
              label="Camera"
              onSelect={video.setCameraDeviceId}
              selectedId={video.cameraDeviceId}
              showChangeHint={false}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Turn your camera on once to list cameras.
            </p>
          )}
        </PopoverContent>
      </Popover>
      <ControlTooltip label={screenLabel}>
        <Button
          aria-disabled={!video.supported || otherSharing}
          aria-label={screenLabel}
          aria-pressed={video.screenOn}
          className={cn(
            "buzz-huddle-control-button h-12 w-12 shrink-0",
            otherSharing && "opacity-60",
          )}
          data-testid="huddle-screen-toggle"
          onClick={() => {
            if (video.supported && !otherSharing) video.toggleScreen();
          }}
          size="icon"
          variant="secondary"
        >
          {video.screenOn ? (
            <ScreenShareOff aria-hidden="true" className="h-4 w-4" />
          ) : (
            <ScreenShare aria-hidden="true" className="h-4 w-4" />
          )}
        </Button>
      </ControlTooltip>
      {video.error ? (
        <div
          className="flex min-w-0 items-center gap-1.5 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="huddle-video-error"
          role="alert"
        >
          <span className="max-w-[260px] truncate" title={video.error}>
            {video.error}
          </span>
          <button
            aria-label="Dismiss video error"
            className="ml-1 opacity-60 hover:opacity-100"
            onClick={video.clearError}
            type="button"
          >
            ✕
          </button>
        </div>
      ) : null}
    </>
  );
}
