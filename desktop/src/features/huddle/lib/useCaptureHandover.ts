import { emit, listen } from "@tauri-apps/api/event";
import * as React from "react";

const HANDOVER_EVENT = "huddle-capture-handover";
const CLAIM_RETRY_MS = 1500;
const MAX_CLAIMS = 5;

type Handover = { type: "claim" } | { type: "released" } | { type: "returned" };

type Args = {
  /** The main window: owns the huddle lifecycle and takes capture back. */
  isSessionWindow: boolean;
  /** This window shows huddle video, so it should hold the mic too. */
  capturePreferred: boolean;
  ownsCapture: boolean;
  setOwnsCapture: (owns: boolean) => void;
  /** The other window reports a live mic (so there is something to claim). */
  peerHasCapture: boolean;
  /** A huddle is live here, so taking capture back should open the mic. */
  huddleLive: boolean;
  /** Stop local capture; the session keeps running. */
  release: () => void;
  /** Adopt the mirrored settings and open the mic here. */
  take: () => void;
};

/**
 * Moves the microphone to whichever window shows huddle video. WebKit mutes
 * capture in every other page when one page starts capturing, so a camera
 * in the room window would silence a mic left in the main window.
 *
 * The room claims, the main window releases and acknowledges, then the room
 * opens the mic, so two windows never push PCM at once. Closing the room
 * hands the mic back.
 */
export function useCaptureHandover({
  isSessionWindow,
  capturePreferred,
  ownsCapture,
  setOwnsCapture,
  peerHasCapture,
  huddleLive,
  release,
  take,
}: Args) {
  const latest = React.useRef({ ownsCapture, capturePreferred, release, take });
  latest.current = { ownsCapture, capturePreferred, release, take };

  React.useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<Handover>(HANDOVER_EVENT, (event) => {
      if (cancelled) return;
      const now = latest.current;
      const kind = event.payload.type;
      if (kind === "claim" && now.ownsCapture && !now.capturePreferred) {
        now.release();
        setOwnsCapture(false);
        void emit(HANDOVER_EVENT, { type: "released" } satisfies Handover);
        return;
      }
      if (kind === "released" && !now.ownsCapture && now.capturePreferred) {
        setOwnsCapture(true);
        now.take();
        return;
      }
      if (kind === "returned" && isSessionWindow && !now.ownsCapture) {
        setOwnsCapture(true);
        if (huddleLive) now.take();
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [huddleLive, isSessionWindow, setOwnsCapture]);

  // The room asks for the mic once the main window reports a live one.
  React.useEffect(() => {
    if (
      isSessionWindow ||
      !capturePreferred ||
      ownsCapture ||
      !peerHasCapture
    ) {
      return;
    }
    let claims = 0;
    const claim = () => {
      claims += 1;
      void emit(HANDOVER_EVENT, { type: "claim" } satisfies Handover);
    };
    claim();
    const timer = window.setInterval(() => {
      if (claims >= MAX_CLAIMS) {
        window.clearInterval(timer);
        return;
      }
      claim();
    }, CLAIM_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [capturePreferred, isSessionWindow, ownsCapture, peerHasCapture]);

  // The room went away (closed or returned to the drawer): take the mic back.
  React.useEffect(() => {
    if (!isSessionWindow || !capturePreferred || ownsCapture) return;
    setOwnsCapture(true);
    if (huddleLive) latest.current.take();
  }, [
    capturePreferred,
    huddleLive,
    isSessionWindow,
    ownsCapture,
    setOwnsCapture,
  ]);

  // A room that unmounts while holding the mic hands it back.
  React.useEffect(() => {
    if (isSessionWindow) return;
    return () => {
      if (!latest.current.ownsCapture) return;
      latest.current.release();
      void emit(HANDOVER_EVENT, { type: "returned" } satisfies Handover);
    };
  }, [isSessionWindow]);
}
