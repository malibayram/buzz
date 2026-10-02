import { invoke } from "@tauri-apps/api/core";
import * as React from "react";

import { useProfileQuery, useSelfProfileCache } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useHuddle, useHuddleLevels } from "../HuddleContext";
import { useHuddleParticipantRoster } from "../hooks/useHuddleParticipantRoster";
import {
  isHuddleRosterVisible,
  useHuddleRosterState,
} from "../hooks/useHuddleRosterState";
import { HuddleParticipantsControl } from "./ParticipantList";

/** Larger, persistent roster for the companion huddle room window. */
export function HuddleRoomHeader() {
  const { interruptAgentSpeech, isMuted, micConnected } = useHuddle();
  const { activeSpeakers, micLevel, speakerLevels } = useHuddleLevels();
  const identityQuery = useIdentityQuery();
  const profileQuery = useProfileQuery();
  const selfProfileCache = useSelfProfileCache();
  const [state, setState] = useHuddleRosterState();
  const currentPubkey = identityQuery.data?.pubkey ?? null;
  const lifecycleParticipants = useHuddleParticipantRoster({
    parentChannelId: state?.parent_channel_id ?? null,
    ephemeralChannelId: state?.ephemeral_channel_id ?? null,
    fallbackParticipants: state?.participants ?? [],
    preservedParticipants: state?.agent_pubkeys ?? [],
    huddleThreadEventId: state?.huddle_thread_event_id ?? null,
  });
  const participantSpeakerLevels = React.useMemo(() => {
    const levels = { ...speakerLevels };
    if (currentPubkey) {
      levels[currentPubkey.toLowerCase()] =
        micConnected && !isMuted ? micLevel : 0;
    }
    return levels;
  }, [currentPubkey, isMuted, micConnected, micLevel, speakerLevels]);
  const handleRemoveAgent = React.useCallback(
    async (pubkey: string) => {
      if (!window.confirm("Remove this agent from the huddle?")) return;
      try {
        await invoke("remove_agent_from_huddle", {
          agentPubkey: pubkey,
        });
        setState((current) =>
          current
            ? {
                ...current,
                participants: current.participants.filter(
                  (member) => member !== pubkey,
                ),
                agent_pubkeys: current.agent_pubkeys.filter(
                  (agent) => agent !== pubkey,
                ),
              }
            : current,
        );
      } catch (error) {
        console.error("Failed to remove agent from huddle:", error);
      }
    },
    [setState],
  );

  if (!state || !isHuddleRosterVisible(state)) return null;

  return (
    <header className="flex min-h-24 shrink-0 items-center justify-center border-b border-border/60 bg-background/85 px-6 py-3 backdrop-blur-sm">
      <HuddleParticipantsControl
        activeSpeakers={activeSpeakers}
        speakerLevels={participantSpeakerLevels}
        agentPubkeys={state.agent_pubkeys}
        agentVoiceSettings={state.agent_voice_settings}
        appearance="room"
        onInterruptAgentSpeech={(agentPubkey) =>
          void interruptAgentSpeech(agentPubkey)
        }
        onRemoveAgent={handleRemoveAgent}
        participants={lifecycleParticipants}
        selfProfile={{
          avatarUrl:
            profileQuery.data?.avatarUrl ??
            selfProfileCache?.avatarDataUrl ??
            null,
          displayName:
            profileQuery.data?.displayName ??
            identityQuery.data?.displayName ??
            null,
          pubkey: currentPubkey,
        }}
      />
    </header>
  );
}
