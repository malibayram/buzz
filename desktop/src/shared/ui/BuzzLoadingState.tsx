import { cn } from "@/shared/lib/cn";
import { FlappingBee } from "@/shared/ui/buzz-logo/FlappingBee";

/** Centered, low-emphasis loading state for page and panel fetches. */
export function BuzzLoadingState({
  className,
  fill = false,
  label = "Loading",
}: {
  className?: string;
  fill?: boolean;
  label?: string;
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        "flex w-full items-center justify-center opacity-60",
        fill ? "min-h-0 flex-1" : "min-h-[calc(100dvh-7rem)]",
        className,
      )}
      data-testid="buzz-loading-state"
      role="status"
    >
      <FlappingBee className="w-8" />
    </div>
  );
}
