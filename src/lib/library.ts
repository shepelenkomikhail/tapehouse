import { appendUniqueTracks, createPlaylist } from "../../shared/playlist-ops";
import type { Playlist, Track } from "../../shared/types";
import { collectGarbage, deleteDoc, loadDocs, saveDoc } from "./cloud-storage";

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
}

interface LibDoc {
  v: 1;
  inboxId: string | null;
  playlists: Omit<Playlist, "tracks">[];
  groups: KnownGroup[];
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

export async function loadLibrary(): Promise<PersonalLibrary> {
  const { lib } = await loadDocs<LibDoc>(["lib"]);
  if (!lib) {
    return { playlists: [], inboxId: null, groups: [] };
  }

  const names = lib.playlists.map((playlist) => docName(playlist.id));
  const docs = await loadDocs<CompactTrack[]>(names);
  const playlists = lib.playlists.map((meta) => ({
    ...meta,
    tracks: (docs[docName(meta.id)] ?? []).map(unpack),
  }));

  void collectGarbage(["lib", ...names]).catch(() => undefined);
  return { playlists, inboxId: lib.inboxId, groups: lib.groups ?? [] };
}

/**
 * Persists what changed between two library states. Playlists are compared by reference,
 * so unchanged playlists cost no CloudStorage writes.
 */
export async function persistLibrary(previous: PersonalLibrary, next: PersonalLibrary) {
  const writes: Promise<void>[] = [];
  const before = new Map(previous.playlists.map((playlist) => [playlist.id, playlist]));

  for (const playlist of next.playlists) {
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
  };
  writes.push(saveDoc("lib", lib));
  await Promise.all(writes);
}

/** Moves tracks the bot collected into the "Inbox" playlist (creating it if needed). */
export function mergeInbox(library: PersonalLibrary, incoming: Track[]) {
  if (incoming.length === 0) {
    return { library, added: 0 };
  }

  let inbox = library.playlists.find((playlist) => playlist.id === library.inboxId);
  let playlists = library.playlists;
  if (!inbox) {
    inbox = createPlaylist("Inbox", "Tracks you send to the bot land here.");
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
