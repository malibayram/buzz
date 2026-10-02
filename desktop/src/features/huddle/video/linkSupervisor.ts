import { noopVideoLink, type VideoLink } from "./videoTransport";

export type LinkState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "failed";

type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

type SupervisorDeps = {
  /** Open one link; `onClose` fires if that link later drops. */
  open: (onClose: () => void) => Promise<VideoLink>;
  /** Called on every state change with the link that is current now. */
  onChange: (state: LinkState, link: VideoLink) => void;
  timers?: Timers;
};

export const BASE_RETRY_MS = 500;
export const MAX_RETRY_MS = 8000;
/** Consecutive failed attempts before giving up until the user retries. */
export const MAX_ATTEMPTS = 6;

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type LinkSupervisor = {
  start: () => void;
  stop: () => void;
  /** Leave `failed` (or skip a pending backoff) and connect now. */
  retry: () => void;
  /** Enter `failed` immediately, e.g. after a non-retryable relay error. */
  fail: () => void;
  link: () => VideoLink;
  state: () => LinkState;
};

/**
 * Keeps one video link alive: reconnects with capped exponential backoff,
 * stops after `MAX_ATTEMPTS` straight failures, and fences every async result
 * by generation so a stale attempt can never replace a newer link.
 */
export function createLinkSupervisor({
  open,
  onChange,
  timers = browserTimers,
}: SupervisorDeps): LinkSupervisor {
  let generation = 0;
  let attempts = 0;
  let running = false;
  let timer: unknown = null;
  let current = noopVideoLink();
  let state: LinkState = "idle";

  const set = (next: LinkState) => {
    state = next;
    onChange(next, current);
  };
  const clearTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const drop = () => {
    const previous = current;
    current = noopVideoLink();
    previous.close();
  };
  const lost = (mine: number) => {
    if (mine !== generation || !running) return;
    drop();
    if (attempts >= MAX_ATTEMPTS) {
      set("failed");
      return;
    }
    const delay = Math.min(BASE_RETRY_MS * 2 ** attempts, MAX_RETRY_MS);
    attempts += 1;
    set("reconnecting");
    timer = timers.set(() => {
      timer = null;
      connect();
    }, delay);
  };
  const connect = () => {
    clearTimer();
    const mine = ++generation;
    if (state !== "reconnecting") set("connecting");
    open(() => lost(mine)).then(
      (link) => {
        if (mine !== generation || !running) {
          link.close();
          return;
        }
        current = link;
        attempts = 0;
        set("open");
      },
      () => lost(mine),
    );
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      attempts = 0;
      connect();
    },
    stop: () => {
      running = false;
      generation += 1;
      clearTimer();
      drop();
      set("idle");
    },
    retry: () => {
      if (!running) return;
      attempts = 0;
      drop();
      set("connecting");
      connect();
    },
    fail: () => {
      if (!running) return;
      generation += 1;
      clearTimer();
      drop();
      set("failed");
    },
    link: () => current,
    state: () => state,
  };
}
