import { BuzzMark } from "./BuzzMark";
import "./buzz-logo-animation.css";

/**
 * The MagiBuzz mark with a gentle scale pulse for loading gates and landing
 * decorations. The pulse is a CSS transform on an HTML element, so it keeps
 * running on the compositor while boot work holds the main thread. Reduced
 * motion falls back to the static mark via the CSS media query.
 */
export function FlappingBee({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={["buzz-logo--scale-pulse", "relative", className]
        .filter(Boolean)
        .join(" ")}
    >
      <BuzzMark className="buzz-logo__mark block h-auto w-full" />
    </div>
  );
}
