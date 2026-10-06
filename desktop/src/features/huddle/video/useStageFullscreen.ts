import { getCurrentWindow } from "@tauri-apps/api/window";
import * as React from "react";

import type { VideoTile } from "./protocol";

function setWindowFullscreen(value: boolean) {
  void getCurrentWindow()
    .setFullscreen(value)
    .catch(() => undefined);
}

/**
 * One tile (a shared screen) shown in OS full screen.
 *
 * Entering puts the window into full screen; leaving restores it. Full screen
 * also ends on its own when the tile goes away (the share stopped) or when the
 * window leaves full screen some other way (the green button, the View menu),
 * so the viewer is never left in an overlay with no window state behind it.
 */
export function useStageFullscreen(tiles: readonly VideoTile[]) {
  const [fullscreenKey, setFullscreenKey] = React.useState<string | null>(null);
  // Whether the window has actually reached full screen for this entry. The
  // OS animates the transition, so a "not full screen" reading before that is
  // the start of the entry, not the viewer leaving.
  const reached = React.useRef(false);

  const enterFullscreen = React.useCallback((key: string) => {
    reached.current = false;
    setFullscreenKey(key);
    setWindowFullscreen(true);
  }, []);

  const keyRef = React.useRef(fullscreenKey);
  keyRef.current = fullscreenKey;
  const exitFullscreen = React.useCallback(() => {
    if (keyRef.current === null) return;
    setFullscreenKey(null);
    setWindowFullscreen(false);
  }, []);

  React.useEffect(() => {
    if (fullscreenKey && !tiles.some((tile) => tile.key === fullscreenKey)) {
      exitFullscreen();
    }
  }, [exitFullscreen, fullscreenKey, tiles]);

  React.useEffect(() => {
    if (!fullscreenKey) return;
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const check = () => {
      void appWindow
        .isFullscreen()
        .then((value) => {
          if (cancelled) return;
          if (value) reached.current = true;
          else if (reached.current) setFullscreenKey(null);
        })
        .catch(() => undefined);
    };
    void appWindow
      .onResized(check)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fullscreenKey]);

  // Leaving the huddle window's video session mid-presentation restores it.
  React.useEffect(
    () => () => {
      if (reached.current) setWindowFullscreen(false);
    },
    [],
  );

  return { fullscreenKey, enterFullscreen, exitFullscreen };
}
