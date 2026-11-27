import { appendUniqueTracks, createPlaylist } from "../../shared/playlist-ops";
import type { Playlist, Track } from "../../shared/types";
import {
  collectGarbage,
  deleteDoc,
  docChunkCount,
  loadDocs,
  loadDocText,
  markNewDoc,
  prefetchHeaders,
  saveDoc,
} from "./cloud-storage";

/**
 * Personal library persisted in Telegram CloudStorage.
 *
 *   "lib"       → playlist order + metadata + remembered groups
 *   "pl_<id>"   → that playlist's tracks, in compact array form
 */

export interface KnownGroup {
  chatId: string;
  title: string;
}

export interface PersonalLibrary {
  playlists: Playlist[];
  inboxId: string | null;
  groups: KnownGroup[];
  /** Chats the user hid; auto-discovery won't add them back. */
  hiddenGroups: string[];
}

interface LibDoc {
  v: 1;
  inboxId: string | null;
  playlists: Omit<Playlist, "tracks">[];
  groups: KnownGroup[];
  hiddenGroups?: string[];
}

/** [id, title, performer, durationSec, fileId, fileUniqueId, sig, isDocument, addedAt] */
type CompactTrack = [string, string, string, number, string, string, string, 0 | 1, string];

const pack = (t: Track): CompactTrack => [
  t.id, t.title, t.performer, t.durationSec, t.fileId, t.fileUniqueId ?? "", t.sig, t.kind === "document" ? 1 : 0, t.addedAt,
];

const unpack = (c: CompactTrack): Track => ({
  id: c[0],
  title: c[1],
  performer: c[2],
  durationSec: c[3],
  fileId: c[4],
  fileUniqueId: c[5] || undefined,
  sig: c[6],
  kind: c[7] === 1 ? "document" : "audio",
  addedAt: c[8],
});

const docName = (playlistId: string) => `pl_${playlistId}`;

/**
 * Reads only the library index (playlist names, order, groups) plus the size of every playlist.
 * Tracks come later from `createPlaylistLoader`, so the app opens without waiting for big playlists.
 * Every playlist starts with an empty track list and stays "loading" until its loader reports done.
 */
export async function loadLibraryIndex(): Promise<PersonalLibrary> {
  const { lib } = await loadDocs<LibDoc>(["lib"]);
  if (!lib) {
    return { playlists: [], inboxId: null, groups: [], hiddenGroups: [] };
  }
  await prefetchHeaders(lib.playlists.map((playlist) => docName(playlist.id)));
  return {
    playlists: lib.playlists.map((meta) => ({ ...meta, tracks: [] })),
    inboxId: lib.inboxId,
    groups: lib.groups ?? [],
    hiddenGroups: lib.hiddenGroups ?? [],
  };
}

/**
 * Parses as many whole tracks as the text read so far holds. The document is a JSON array of
 * arrays (`[[...],[...],...]`); this finds the end of the last complete inner array.
 */
function parsePartialTracks(text: string): CompactTrack[] {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastEnd = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 1) {
        lastEnd = i;
      }
    }
  }
  if (lastEnd < 0) {
    return [];
  }
  try {
    return JSON.parse(`${text.slice(0, lastEnd + 1)}]`) as CompactTrack[];
  } catch {
    return [];
  }
}

function parseTracks(text: string): Track[] {
  if (!text) {
    return [];
  }
  try {
    return (JSON.parse(text) as CompactTrack[]).map(unpack);
  } catch {
    console.warn("Tapehouse: a playlist document is unreadable");
    return [];
  }
}

/** Documents up to this many storage values load in one request; bigger ones arrive in parts. */
const SMALL_DOC_CHUNKS = 8;
/** Most storage values asked for in one batch of small playlists. */
const BATCH_CHUNKS = 40;

export interface PlaylistLoader {
  /** Load this playlist next (e.g. the user just opened it). */
  prioritize(playlistId: string): void;
  /** Resolves once the playlist's tracks are fully loaded (right away if they already are). */
  whenLoaded(playlistId: string): Promise<void>;
  isLoaded(playlistId: string): boolean;
}

/**
 * Loads playlists' tracks in the background: the one asked for first, then the rest smallest
 * first, so most playlists are ready almost at once. A big playlist is handed over in parts
 * (`done` false) so its first tracks can be played while the rest still loads.
 */
export function createPlaylistLoader(
  playlistIds: string[],
  apply: (playlistId: string, tracks: Track[], done: boolean) => void,
  onError: (error: unknown) => void,
  onAllLoaded: () => void,
): PlaylistLoader {
  const queue = [...playlistIds].sort((a, b) => docChunkCount(docName(a)) - docChunkCount(docName(b)));
  const loaded = new Set<string>();
  const waiters = new Map<string, (() => void)[]>();
  let reportedError = false;
  let running = false;

  const finish = (id: string) => {
    loaded.add(id);
    waiters.get(id)?.forEach((resolve) => resolve());
    waiters.delete(id);
  };

  const nextBatch = () => {
    const first = queue.shift()!;
    const batch = [first];
    let chunks = docChunkCount(docName(first));
    if (chunks > SMALL_DOC_CHUNKS) {
      return batch;
    }
    while (queue.length > 0) {
      const size = docChunkCount(docName(queue[0]));
      if (size > SMALL_DOC_CHUNKS || chunks + size > BATCH_CHUNKS) {
        break;
      }
      chunks += size;
      batch.push(queue.shift()!);
    }
    return batch;
  };

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    while (queue.length > 0) {
      const batch = nextBatch();
      try {
        if (batch.length === 1 && docChunkCount(docName(batch[0])) > SMALL_DOC_CHUNKS) {
          const id = batch[0];
          await loadDocText(docName(id), (text, done) => {
            if (done) {
              apply(id, parseTracks(text), true);
            } else {
              apply(id, parsePartialTracks(text).map(unpack), false);
            }
          });
          finish(id);
        } else {
          const docs = await loadDocs<CompactTrack[]>(batch.map(docName));
          for (const id of batch) {
            apply(id, (docs[docName(id)] ?? []).map(unpack), true);
            finish(id);
          }
        }
      } catch (error) {
        if (!reportedError) {
          reportedError = true;
          onError(error);
        }
        // Try again later; until then these playlists stay "loading" and can't be edited.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        queue.push(...batch.filter((id) => !loaded.has(id)));
      }
    }
    running = false;
    onAllLoaded();
  };

  void run();

  return {
    prioritize(playlistId) {
      const index = queue.indexOf(playlistId);
      if (index > 0) {
        queue.splice(index, 1);
        queue.unshift(playlistId);
      }
    },
    whenLoaded(playlistId) {
      if (loaded.has(playlistId) || !playlistIds.includes(playlistId)) {
        return Promise.resolve();
      }
      this.prioritize(playlistId);
      return new Promise<void>((resolve) => {
        waiters.set(playlistId, [...(waiters.get(playlistId) ?? []), resolve]);
      });
    },
    isLoaded(playlistId) {
      return loaded.has(playlistId) || !playlistIds.includes(playlistId);
    },
  };
}

/** Removes storage leftovers once everything is loaded; reads the library as it is now. */
export function collectLibraryGarbage(library: PersonalLibrary) {
  void collectGarbage(["lib", ...library.playlists.map((playlist) => docName(playlist.id))]).catch(() => undefined);
}

/**
 * Persists what changed between two library states. Playlists are compared by reference,
 * so unchanged playlists cost no CloudStorage writes.
 */
export async function persistLibrary(previous: PersonalLibrary, next: PersonalLibrary) {
  const writes: Promise<void>[] = [];
  const before = new Map(previous.playlists.map((playlist) => [playlist.id, playlist]));

  for (const playlist of next.playlists) {
    if (!before.has(playlist.id)) {
      markNewDoc(docName(playlist.id));
    }
    if (before.get(playlist.id)?.tracks !== playlist.tracks) {
      writes.push(saveDoc(docName(playlist.id), playlist.tracks.map(pack)));
    }
    before.delete(playlist.id);
  }
  for (const removed of before.keys()) {
    writes.push(deleteDoc(docName(removed)));
  }

  const lib: LibDoc = {
    v: 1,
    inboxId: next.inboxId,
    playlists: next.playlists.map(({ tracks: _tracks, ...meta }) => meta),
    groups: next.groups,
    hiddenGroups: next.hiddenGroups,
  };
  writes.push(saveDoc("lib", lib));
  await Promise.all(writes);
}

/** Moves tracks the bot collected into the "Inbox" playlist (creating it if needed). */
export function mergeInbox(
  library: PersonalLibrary,
  incoming: Track[],
  labels: { title: string; description: string },
) {
  if (incoming.length === 0) {
    return { library, added: 0 };
  }

  let inbox = library.playlists.find((playlist) => playlist.id === library.inboxId);
  let playlists = library.playlists;
  if (!inbox) {
    inbox = createPlaylist(labels.title, labels.description);
    playlists = [inbox, ...playlists];
  }

  const merged = appendUniqueTracks(inbox, incoming);
  const updated = { ...merged.playlist, updatedAt: new Date().toISOString() };
  return {
    library: {
      ...library,
      inboxId: updated.id,
      playlists: playlists.map((playlist) => (playlist.id === updated.id ? updated : playlist)),
    },
    added: merged.addedCount,
  };
}
