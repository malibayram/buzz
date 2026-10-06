/**
 * The pin to hold after the set of shared screens changes.
 *
 * The first share in a quiet huddle takes the stage once (the pin clears so
 * the layout promotes it). A share that starts while another screen is
 * already showing must not steal the stage: if nothing is pinned, the screen
 * the viewer was watching gets pinned so it stays put, and the new share
 * waits in the strip until they pick it.
 */
export function nextScreenSharePin({
  previousScreens,
  screens,
  pinnedKey,
}: {
  /** Screen tile keys before the change, in stage order. */
  previousScreens: readonly string[];
  /** Screen tile keys now, in stage order. */
  screens: readonly string[];
  pinnedKey: string | null;
}): string | null {
  const previous = new Set(previousScreens);
  const fresh = screens.some((key) => !previous.has(key));
  if (!fresh) return pinnedKey;
  if (previousScreens.length === 0) return null;
  if (pinnedKey) return pinnedKey;
  const watching = previousScreens.find((key) => screens.includes(key));
  return watching ?? null;
}
