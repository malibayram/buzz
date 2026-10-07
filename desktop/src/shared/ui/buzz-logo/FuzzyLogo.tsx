import { cn } from "@/shared/lib/cn";
import "./buzz-logo-animation.css";

export type FuzzyLogoProps = {
  /** Kept for call-site compatibility; the MagiBuzz mark has no texture pass. */
  fuzz?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Kept for call-site compatibility; the pulse already loops. */
  loop?: boolean;
  /** Kept for call-site compatibility; the pulse already loops. */
  loopRestSeconds?: number;
  /** Set false when a parent drives its own opacity animation over the mark. */
  pulse?: boolean;
};

/** The MagiBuzz mark with an optional opacity pulse for liveness indicators. */
export function FuzzyLogo({
  className,
  ariaLabel = "MagiBuzz logo",
  pulse = true,
}: FuzzyLogoProps) {
  return (
    <span
      className={cn("buzz-logo w-6", pulse && "buzz-logo--pulse", className)}
    >
      <img
        alt={ariaLabel}
        aria-hidden={ariaLabel ? undefined : true}
        className="buzz-logo__mark h-auto w-full"
        draggable={false}
        src="/buzz.svg"
      />
    </span>
  );
}
