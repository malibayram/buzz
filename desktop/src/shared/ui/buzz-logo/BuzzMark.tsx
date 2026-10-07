/**
 * The static MagiBuzz mark. It is a full-color image (`/buzz.svg`), so it
 * paints complete on the very first frame and ignores `currentColor` tints.
 */
export function BuzzMark({ className }: { className?: string }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={["buzz-mark", className].filter(Boolean).join(" ")}
      draggable={false}
      src="/buzz.svg"
    />
  );
}
