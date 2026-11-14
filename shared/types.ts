/**
 * A track always points at an audio file that already lives on Telegram's servers.
 * We never store audio ourselves — only the Telegram `file_id` plus display metadata.
 */
export interface Track {
  id: string;
  title: string;
  performer: string;
  durationSec: number;
  /** Telegram file_id used for streaming and for re-sending the audio into a chat. */
  fileId: string;
  /** Stable across bots/re-uploads; used for duplicate detection. */
  fileUniqueId?: string;
  /** How Telegram stored the file; documents must be re-sent as documents. Defaults to "audio". */
  kind?: "audio" | "document";
  /** Server-issued signature that authorises `/api/stream` for this file. */
  sig: string;
  addedAt: string;
  /** Post number in the channel/group it came from; keeps imported history in posting order. */
  sourceMessageId?: number;
}

export interface Playlist {
  id: string;
  title: string;
  description: string;
  accent: string;
  /** Optional emoji shown as the cover instead of the first letter. */
  emoji?: string;
  createdAt: string;
  updatedAt: string;
  lastShuffleAt?: string;
  tracks: Track[];
}

/** A group's shared playlists, stored server-side in Vercel Blob. */
export interface GroupLibrary {
  chatId: string;
  title: string;
  playlists: Playlist[];
  /** Highest post number the bot has seen in this chat; the end point for history imports. */
  lastMessageId?: number;
  /** The playlist the bot fills with posted/imported tracks. Recreated if it gets deleted. */
  mainPlaylistId?: string;
}

export interface SessionUser {
  id: number;
  firstName: string;
  username?: string;
}

/** Response of GET /api/inbox — who you are, plus tracks the bot collected for you. */
export interface InboxResponse {
  user: SessionUser;
  botUsername?: string;
  inbox: Track[];
  /** Groups/channels with shared playlists that this user is a member of. */
  sharedChats: { chatId: string; title: string }[];
}

/** Operations accepted by POST /api/group. Personal playlists use the same ops client-side. */
export type PlaylistOp =
  | { op: "createPlaylist"; title: string; description?: string }
  | { op: "updatePlaylist"; playlistId: string; title?: string; description?: string; emoji?: string }
  | { op: "deletePlaylist"; playlistId: string }
  | { op: "reorder"; playlistId: string; trackIds: string[] }
  | { op: "shuffle"; playlistId: string }
  | { op: "sortByAdded"; playlistId: string; order: "newest" | "oldest" }
  | { op: "removeTrack"; playlistId: string; trackId: string }
  | { op: "addTracks"; playlistId: string; tracks: Track[] };
