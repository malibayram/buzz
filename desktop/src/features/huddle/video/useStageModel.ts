import * as React from "react";

import { useHuddle, useHuddleLevels } from "../HuddleContext";
import { buildStageTiles, layoutStage } from "./stageLayout";
import { useHuddleVideo } from "./useHuddleVideo";
import { type StagePerson, useStageRoster } from "./useStageRoster";

/** Level above which a participant counts as speaking (matches the roster). */
const SPEAKING_LEVEL = 0.04;

/** Stage tiles, their layout, and per-person labels and speaking state. */
export function useStageModel() {
  const video = useHuddleVideo();
  const { isMuted, micConnected } = useHuddle();
  const { activeSpeakers, micLevel, speakerLevels } = useHuddleLevels();
  const { participants, selfPubkey, person } = useStageRoster();
  const hasLocalCamera = video.localCamera != null;

  const tiles = React.useMemo(
    () =>
      buildStageTiles({
        participants,
        selfPubkey,
        remote: video.tiles,
        localCamera: hasLocalCamera,
      }),
    [hasLocalCamera, participants, selfPubkey, video.tiles],
  );
  const people = React.useMemo(() => {
    const map = new Map<string, StagePerson>();
    for (const tile of tiles)
      map.set(tile.pubkey.toLowerCase(), person(tile.pubkey));
    return map;
  }, [person, tiles]);

  const speaking = React.useMemo(() => {
    const set = new Set(activeSpeakers.map((key) => key.toLowerCase()));
    for (const [key, level] of Object.entries(speakerLevels)) {
      if (level > SPEAKING_LEVEL) set.add(key.toLowerCase());
    }
    if (selfPubkey && micConnected && !isMuted && micLevel > SPEAKING_LEVEL) {
      set.add(selfPubkey.toLowerCase());
    }
    return set;
  }, [
    activeSpeakers,
    isMuted,
    micConnected,
    micLevel,
    selfPubkey,
    speakerLevels,
  ]);

  const speakerList = React.useMemo(() => [...speaking], [speaking]);
  const model = React.useMemo(
    () =>
      layoutStage({
        tiles,
        pinnedKey: video.pinnedKey,
        preference: video.layout,
        activeSpeakers: speakerList,
      }),
    [speakerList, tiles, video.layout, video.pinnedKey],
  );

  const personFor = React.useCallback(
    (pubkey: string) => people.get(pubkey.toLowerCase()) ?? person(pubkey),
    [people, person],
  );
  const isSpeaking = React.useCallback(
    (pubkey: string) => speaking.has(pubkey.toLowerCase()),
    [speaking],
  );

  return { tiles, model, personFor, isSpeaking, speakerList };
}
