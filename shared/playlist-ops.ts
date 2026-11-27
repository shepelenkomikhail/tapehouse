import type { Playlist, PlaylistOp, Track } from "./types.js";

/**
 * Pure playlist mutations shared by the client (personal playlists in Telegram CloudStorage)
 * and the server (group playlists in Vercel Blob), so both behave identically.
 */

const ACCENTS = ["#f35f4c", "#1ba784", "#ffb400", "#4b63ff", "#e84ba5", "#00a3c4"];
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** First user-visible character (a whole emoji like 🗽 or 👨‍👩‍👧, not half of one). */
export function firstGrapheme(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)[Symbol.iterator]().next();
    return segment.done ? "" : segment.value.segment;
  }
  return Array.from(trimmed)[0] ?? "";
}

/** Keeps only the first emoji/character of user input, so covers stay a single glyph. */
export function normalizeEmoji(input: string) {
  return firstGrapheme(input).slice(0, 16);
}

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

/**
 * Orders tracks by when they were added. Channel tracks carry their post number, which is the
 * reliable order there (history imports all get stamped at import time), so it wins when both
 * tracks have one. Ties keep the current order.
 */
export function sortByAdded(tracks: Track[], order: "newest" | "oldest"): Track[] {
  const direction = order === "newest" ? -1 : 1;
  const time = (track: Track) => Date.parse(track.addedAt) || 0;
  return tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const byPost =
        a.track.sourceMessageId !== undefined && b.track.sourceMessageId !== undefined
          ? a.track.sourceMessageId - b.track.sourceMessageId
          : 0;
      const diff = byPost || time(a.track) - time(b.track);
      return diff ? diff * direction : a.index - b.index;
    })
    .map(({ track }) => track);
}

/** Appends tracks, skipping ones already in the playlist (same Telegram file). */
export function appendUniqueTracks(playlist: Playlist, incoming: Track[]) {
  const known = new Set(playlist.tracks.map((track) => track.fileUniqueId ?? track.fileId));
  const added: Track[] = [];
  // "Date added" means added to *this* playlist, even for a track copied from another one.
  const now = new Date().toISOString();

  for (const track of incoming) {
    const key = track.fileUniqueId ?? track.fileId;
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    added.push({ ...track, id: makeId(), addedAt: now });
  }

  return {
    playlist: { ...playlist, tracks: [...playlist.tracks, ...added] },
    addedCount: added.length,
  };
}

/**
 * Adds older tracks (e.g. imported channel history) in posting order: each goes right after the
 * last track with a smaller post number, or at the very start if there is none.
 */
export function insertChronologically(playlist: Playlist, incoming: Track[]) {
  const known = new Set(playlist.tracks.map((track) => track.fileUniqueId ?? track.fileId));
  const tracks = [...playlist.tracks];
  let addedCount = 0;

  const sorted = [...incoming].sort((a, b) => (a.sourceMessageId ?? 0) - (b.sourceMessageId ?? 0));
  for (const track of sorted) {
    const key = track.fileUniqueId ?? track.fileId;
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    const id = track.sourceMessageId ?? 0;
    let position = 0;
    tracks.forEach((existing, index) => {
      if (existing.sourceMessageId !== undefined && existing.sourceMessageId < id) {
        position = index + 1;
      }
    });
    tracks.splice(position, 0, { ...track, id: makeId() });
    addedCount += 1;
  }

  return { playlist: { ...playlist, tracks }, addedCount };
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
      if (op.emoji !== undefined) {
        const emoji = normalizeEmoji(op.emoji);
        if (emoji) {
          next.emoji = emoji;
        } else {
          delete next.emoji; // empty string clears the cover emoji
        }
      }
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
    case "sortByAdded":
      next = { ...current, tracks: sortByAdded(current.tracks, op.order), updatedAt: now };
      break;
    case "removeTrack":
      next = {
        ...current,
        tracks: current.tracks.filter((track) => track.id !== op.trackId),
        updatedAt: now,
      };
      break;
    case "removeTracks": {
      const remove = new Set(op.trackIds);
      next = { ...current, tracks: current.tracks.filter((track) => !remove.has(track.id)), updatedAt: now };
      break;
    }
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
