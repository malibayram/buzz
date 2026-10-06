import { TRACK_SCREEN, type VideoTile } from "./protocol";

/** How a tile is currently shown; absent means it is not rendered anywhere. */
export type TileView = { large: boolean };

/**
 * The layer to request for each tile: nothing for tiles no one is looking at,
 * the screen's only layer, and the high camera layer only where the tile is
 * shown large (main stage, pinned, or a small call's grid). A camera that
 * publishes no high layer (phones send only layer 0) gets its best one; the
 * relay forwards exact layers only, so asking for a missing one shows nothing.
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
    else plan.set(tile.key, view.large ? bestCameraLayer(tile) : 0);
  }
  return plan;
}

/** Layer 1 unless the publisher advertises layers without it. */
function bestCameraLayer(tile: VideoTile): number {
  return tile.layers.length === 0 || tile.layers.includes(1) ? 1 : 0;
}
