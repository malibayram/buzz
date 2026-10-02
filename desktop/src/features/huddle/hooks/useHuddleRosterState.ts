import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as React from "react";

import type { HuddleAgentVoiceSettings } from "../components/AgentVoiceMenu";

export type HuddleRosterState = {
  phase:
    | "idle"
    | "creating"
    | "connecting"
    | "connected"
    | "active"
    | "leaving";
  participants: string[];
  agent_pubkeys: string[];
  agent_voice_settings: Record<string, HuddleAgentVoiceSettings>;
  parent_channel_id: string | null;
  ephemeral_channel_id: string | null;
  huddle_thread_event_id: string | null;
};

export function isHuddleRosterVisible(state: HuddleRosterState | null) {
  return state?.phase === "connected" || state?.phase === "active";
}

/** Rust's huddle state, kept current from `huddle-state-changed`. */
export function useHuddleRosterState() {
  const [state, setState] = React.useState<HuddleRosterState | null>(null);
  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void invoke<HuddleRosterState>("get_huddle_state")
      .then((next) => {
        if (!disposed) setState(next);
      })
      .catch(() => {
        if (!disposed) setState(null);
      });

    void listen<HuddleRosterState>("huddle-state-changed", (event) => {
      if (!disposed) setState(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return [state, setState] as const;
}
