import type { Playlist, PlaylistOp, Track } from "./types.js";

/**
 * Pure playlist mutations shared by the client (personal playlists in Telegram CloudStorage)
 * and the server (group playlists in Vercel Blob), so both behave identically.
 */

const ACCENTS = ["#f35f4c", "#1ba784", "#ffb400", "#4b63ff", "#e84ba5", "#00a3c4"];
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Short ids using only characters allowed in Telegram CloudStorage keys. */
export function makeId(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

export function createPlaylist(
  title: string,
  description = "",
  existingCount = 0,
): Playlist {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: title.trim().slice(0, 80) || "Untitled playlist",
    description: description.trim().slice(0, 200),
    accent: ACCENTS[existingCount % ACCENTS.length],
    createdAt: now,
    updatedAt: now,
    tracks: [],
  };
}

/**
 * Shuffle that avoids putting the same artist back to back whenever that's possible.
 * A random pick is only accepted if the remaining tracks can still be arranged without
 * repeats — a plain greedy shuffle can paint itself into a corner (e.g. A B A B A A).
 */
export function smartShuffle<T extends { performer: string }>(items: T[]): T[] {
  const artistOf = (item: T) => item.performer.trim().toLowerCase();
  const pool = [...items];
  const counts = new Map<string, number>();
  for (const item of pool) {
    counts.set(artistOf(item), (counts.get(artistOf(item)) ?? 0) + 1);
  }

  // After taking one track by `picked`, can the rest still avoid adjacent repeats?
  const stillSolvable = (picked: string) => {
    const remaining = pool.length - 1;
    let maxArtist = "";
    let maxCount = 0;
    for (const [artist, count] of counts) {
      const left = artist === picked ? count - 1 : count;
      if (left > maxCount) {
        maxArtist = artist;
        maxCount = left;
      }
    }
    // The most frequent artist needs a different track between each of its own.
    return maxCount <= remaining - maxCount + (maxArtist === picked ? 0 : 1);
  };

  const result: T[] = [];
  let previous: string | null = null;

  while (pool.length > 0) {
    const fresh = pool.filter((item) => artistOf(item) !== previous);
    const safe = fresh.filter((item) => stillSolvable(artistOf(item)));
    const source = safe.length > 0 ? safe : fresh.length > 0 ? fresh : pool;
    const next = source[Math.floor(Math.random() * source.length)];
    pool.splice(pool.indexOf(next), 1);
    counts.set(artistOf(next), (counts.get(artistOf(next)) ?? 1) - 1);
    result.push(next);
    previous = artistOf(next);
  }

  return result;
}

export function reorderTracks(tracks: Track[], trackIds: string[]): Track[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const ordered: Track[] = [];
  const seen = new Set<string>();

  for (const id of trackIds) {
    const track = byId.get(id);
    if (track && !seen.has(id)) {
      ordered.push(track);
      seen.add(id);
    }
  }

  // Tracks the caller didn't mention (e.g. added concurrently) keep their place at the end.
  for (const track of tracks) {
    if (!seen.has(track.id)) {
      ordered.push(track);
    }
  }

  return ordered;
}

/** Appends tracks, skipping ones already in the playlist (same Telegram file). */
export function appendUniqueTracks(playlist: Playlist, incoming: Track[]) {
  const known = new Set(playlist.tracks.map((track) => track.fileUniqueId ?? track.fileId));
  const added: Track[] = [];

  for (const track of incoming) {
    const key = track.fileUniqueId ?? track.fileId;
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    added.push({ ...track, id: makeId() });
  }

  return {
    playlist: { ...playlist, tracks: [...playlist.tracks, ...added] },
    addedCount: added.length,
  };
}

export class PlaylistOpError extends Error {}

/** Applies an operation to a list of playlists and returns the new list. Never mutates input. */
export function applyPlaylistOp(playlists: Playlist[], op: PlaylistOp): Playlist[] {
  const now = new Date().toISOString();

  if (op.op === "createPlaylist") {
    return [...playlists, createPlaylist(op.title, op.description, playlists.length)];
  }

  const index = playlists.findIndex((playlist) => playlist.id === op.playlistId);
  if (index < 0) {
    throw new PlaylistOpError("Playlist not found.");
  }

  const current = playlists[index];
  let next: Playlist | null;

  switch (op.op) {
    case "updatePlaylist":
      next = {
        ...current,
        title: op.title !== undefined ? op.title.trim().slice(0, 80) || current.title : current.title,
        description:
          op.description !== undefined ? op.description.trim().slice(0, 200) : current.description,
        updatedAt: now,
      };
      break;
    case "deletePlaylist":
      next = null;
      break;
    case "reorder":
      next = { ...current, tracks: reorderTracks(current.tracks, op.trackIds), updatedAt: now };
      break;
    case "shuffle":
      next = { ...current, tracks: smartShuffle(current.tracks), lastShuffleAt: now, updatedAt: now };
      break;
    case "removeTrack":
      next = {
        ...current,
        tracks: current.tracks.filter((track) => track.id !== op.trackId),
        updatedAt: now,
      };
      break;
    case "addTracks":
      next = { ...appendUniqueTracks(current, op.tracks).playlist, updatedAt: now };
      break;
  }

  const copy = [...playlists];
  if (next) {
    copy[index] = next;
  } else {
    copy.splice(index, 1);
  }
  return copy;
}
