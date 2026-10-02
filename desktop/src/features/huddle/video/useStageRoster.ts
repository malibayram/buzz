import * as React from "react";

import {
  useProfileQuery,
  useSelfProfileCache,
  useUsersBatchQuery,
} from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { truncateNpub } from "@/shared/lib/pubkey";
import { useHuddleParticipantRoster } from "../hooks/useHuddleParticipantRoster";
import { useHuddleRosterState } from "../hooks/useHuddleRosterState";

export type StagePerson = {
  displayName: string;
  initialsLabel: string;
  avatarUrl: string | null;
  isAgent: boolean;
};

/** Who is in the huddle, and how to label each of them on a tile. */
export function useStageRoster() {
  const [state] = useHuddleRosterState();
  const identityQuery = useIdentityQuery();
  const profileQuery = useProfileQuery();
  const selfProfileCache = useSelfProfileCache();
  const selfPubkey = identityQuery.data?.pubkey ?? null;
  const participants = useHuddleParticipantRoster({
    parentChannelId: state?.parent_channel_id ?? null,
    ephemeralChannelId: state?.ephemeral_channel_id ?? null,
    fallbackParticipants: state?.participants ?? [],
    preservedParticipants: state?.agent_pubkeys ?? [],
    huddleThreadEventId: state?.huddle_thread_event_id ?? null,
  });
  const { data } = useUsersBatchQuery(participants);
  const agentKeys = React.useMemo(
    () => new Set((state?.agent_pubkeys ?? []).map((key) => key.toLowerCase())),
    [state?.agent_pubkeys],
  );
  const selfName =
    profileQuery.data?.displayName ?? identityQuery.data?.displayName ?? null;
  const selfAvatar =
    profileQuery.data?.avatarUrl ?? selfProfileCache?.avatarDataUrl ?? null;

  const person = React.useCallback(
    (pubkey: string): StagePerson => {
      const id = pubkey.toLowerCase();
      const isSelf = id === selfPubkey?.toLowerCase();
      const profile = data?.profiles?.[id];
      const authored =
        (isSelf ? selfName : null) ?? profile?.displayName?.trim();
      const isAgent = agentKeys.has(id);
      const keyLabel = truncateNpub(pubkey);
      return {
        displayName:
          authored || `${isAgent ? "Agent" : "Participant"} ${keyLabel}`,
        initialsLabel: authored || keyLabel,
        avatarUrl: (isSelf ? selfAvatar : null) ?? profile?.avatarUrl ?? null,
        isAgent,
      };
    },
    [agentKeys, data?.profiles, selfAvatar, selfName, selfPubkey],
  );

  return { participants, selfPubkey, person };
}
