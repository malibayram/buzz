import { TRACK_CAMERA, TRACK_SCREEN, type VideoTile } from "./protocol";

export const LOCAL_CAMERA_KEY = "local:camera";

/** One box on the stage: a person (camera or avatar) or a shared screen. */
export type StageTile = {
  key: string;
  kind: "camera" | "avatar" | "screen";
  pubkey: string;
  isSelf: boolean;
  /** The remote track to decode; absent for the local camera and avatars. */
  remote: VideoTile | null;
};

export type StageModel =
  | { mode: "grid"; columns: number; tiles: StageTile[]; large: Set<string> }
  | {
      mode: "presentation";
      main: StageTile;
      strip: StageTile[];
      large: Set<string>;
    };

const lower = (value: string) => value.toLowerCase();

/**
 * Every participant gets one tile (their camera, else their avatar), plus a
 * tile per remote screen share. Cameras from peers the roster has not caught
 * up with yet still appear. The viewer's own tile goes last, as in Meet.
 */
export function buildStageTiles({
  participants,
  selfPubkey,
  remote,
  localCamera,
}: {
  participants: readonly string[];
  selfPubkey: string | null;
  remote: readonly VideoTile[];
  localCamera: boolean;
}): StageTile[] {
  const self = selfPubkey ? lower(selfPubkey) : null;
  const cameras = new Map<string, VideoTile>();
  for (const tile of remote) {
    if (tile.track === TRACK_CAMERA) cameras.set(lower(tile.pubkey), tile);
  }
  const people: string[] = [];
  const seen = new Set<string>();
  const add = (pubkey: string) => {
    const key = lower(pubkey);
    if (seen.has(key)) return;
    seen.add(key);
    people.push(pubkey);
  };
  for (const pubkey of participants) add(pubkey);
  for (const tile of remote) add(tile.pubkey);
  if (selfPubkey) add(selfPubkey);

  const tiles: StageTile[] = [];
  for (const pubkey of people) {
    const id = lower(pubkey);
    if (id === self) continue;
    const camera = cameras.get(id);
    tiles.push(
      camera
        ? {
            key: camera.key,
            kind: "camera",
            pubkey,
            isSelf: false,
            remote: camera,
          }
        : {
            key: `person:${id}`,
            kind: "avatar",
            pubkey,
            isSelf: false,
            remote: null,
          },
    );
  }
  if (selfPubkey) {
    tiles.push(
      localCamera
        ? {
            key: LOCAL_CAMERA_KEY,
            kind: "camera",
            pubkey: selfPubkey,
            isSelf: true,
            remote: null,
          }
        : {
            key: `person:${self}`,
            kind: "avatar",
            pubkey: selfPubkey,
            isSelf: true,
            remote: null,
          },
    );
  }
  // The relay lists our own tracks too; our share is shown as a banner and
  // its frames never come back to us, so it must not become a remote tile.
  const screens = remote
    .filter(
      (tile) => tile.track === TRACK_SCREEN && lower(tile.pubkey) !== self,
    )
    .map<StageTile>((tile) => ({
      key: tile.key,
      kind: "screen",
      pubkey: tile.pubkey,
      isSelf: false,
      remote: tile,
    }));
  return [...screens, ...tiles];
}

export function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * Grid unless something deserves the stage: a pin or a screen share (in
 * "auto"), or always in "speaker". The main tile is the pin, else the share,
 * else the loudest remote speaker, else the first remote tile.
 */
export function layoutStage({
  tiles,
  pinnedKey,
  preference,
  activeSpeakers,
}: {
  tiles: readonly StageTile[];
  pinnedKey: string | null;
  preference: "auto" | "grid" | "speaker";
  activeSpeakers: readonly string[];
}): StageModel {
  const pinned = pinnedKey
    ? tiles.find((tile) => tile.key === pinnedKey)
    : undefined;
  const screen = tiles.find((tile) => tile.kind === "screen");
  const presenting =
    preference === "speaker" ||
    (preference === "auto" && (pinned != null || screen != null));
  if (!presenting || tiles.length < 2) {
    // In a call of three or fewer every tile is big enough for the high layer.
    const large = new Set(tiles.length <= 3 ? tiles.map((t) => t.key) : []);
    return {
      mode: "grid",
      columns: gridColumns(tiles.length),
      tiles: [...tiles],
      large,
    };
  }
  const speaking = new Set(activeSpeakers.map(lower));
  const main =
    pinned ??
    screen ??
    tiles.find((tile) => !tile.isSelf && speaking.has(lower(tile.pubkey))) ??
    tiles.find((tile) => !tile.isSelf) ??
    tiles[0];
  if (!main) {
    return { mode: "grid", columns: 1, tiles: [], large: new Set() };
  }
  return {
    mode: "presentation",
    main,
    strip: tiles.filter((tile) => tile.key !== main.key),
    large: new Set([main.key]),
  };
}

/** The single tile a compact dock shows, or null when there is no video. */
export function dockTile({
  tiles,
  pinnedKey,
  activeSpeakers,
}: {
  tiles: readonly StageTile[];
  pinnedKey: string | null;
  activeSpeakers: readonly string[];
}): StageTile | null {
  const video = tiles.filter((tile) => tile.kind !== "avatar");
  if (video.length === 0) return null;
  const speaking = new Set(activeSpeakers.map(lower));
  return (
    video.find((tile) => tile.kind === "screen") ??
    video.find((tile) => tile.key === pinnedKey) ??
    video.find((tile) => !tile.isSelf && speaking.has(lower(tile.pubkey))) ??
    video.find((tile) => !tile.isSelf) ??
    video[0] ??
    null
  );
}
