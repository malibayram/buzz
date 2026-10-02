import { TRACK_SCREEN, type VideoTile } from "./protocol";

/** How a tile is currently shown; absent means it is not rendered anywhere. */
export type TileView = { large: boolean };

/**
 * The layer to request for each tile: nothing for tiles no one is looking at,
 * the screen's only layer, and the high camera layer only where the tile is
 * shown large (main stage, pinned, or a small call's grid).
 */
export function planSubscriptions(
  tiles: readonly VideoTile[],
  views: ReadonlyMap<string, TileView>,
): Map<string, number | null> {
  const plan = new Map<string, number | null>();
  for (const tile of tiles) {
    const view = views.get(tile.key);
    if (!view) plan.set(tile.key, null);
    else if (tile.track === TRACK_SCREEN) plan.set(tile.key, 0);
    else plan.set(tile.key, view.large ? 1 : 0);
  }
  return plan;
}
