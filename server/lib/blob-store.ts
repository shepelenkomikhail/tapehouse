import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import type { GroupLibrary, Track } from "../../shared/types.js";
import { getEnv } from "./env.js";

/**
 * Thin JSON document layer over a *private* Vercel Blob store.
 *
 * Only two kinds of documents live here:
 *   {env}/inbox/{userId}.json  – tracks the bot received, waiting for the Mini App to pick them up
 *   {env}/groups/{chatId}.json – shared playlists of a Telegram group
 *
 * Personal playlists are NOT stored here; they live in the user's Telegram CloudStorage.
 * That keeps us far below the Hobby plan's 2,000 Blob writes/month.
 */

const MAX_ATTEMPTS = 5;

function path(kind: "inbox" | "groups" | "index", id: string | number) {
  return `${getEnv().dataPrefix}/${kind}/${id}.json`;
}

async function readDoc<T>(pathname: string): Promise<{ data: T; etag: string } | null> {
  // useCache:false gives read-after-write consistency for documents we overwrite.
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) {
    return null;
  }
  const text = await new Response(result.stream).text();
  // Reads can return a weak ETag (W/"…", e.g. when the response was compressed). Conditional
  // writes compare strong ETags, so a weak one never matches and every write fails. The hash
  // inside is the same, so strip the W/ marker.
  return { data: JSON.parse(text) as T, etag: result.blob.etag.replace(/^W\//, "") };
}

function isConflict(error: unknown) {
  if (error instanceof BlobPreconditionFailedError) {
    return true;
  }
  // Creating a pathname that a concurrent request just created.
  return error instanceof Error && /already exists/i.test(error.message);
}

/**
 * Optimistic read-modify-write. `mutate` returns the new document, or `null` to delete it.
 * Retries when another request changed the document in between.
 */
async function mutateDoc<T, R>(
  pathname: string,
  mutate: (current: T | null) => { next: T | null; result: R },
): Promise<R> {
  for (let attempt = 1; ; attempt += 1) {
    const current = await readDoc<T>(pathname);
    const { next, result } = mutate(current?.data ?? null);

    try {
      if (next === null) {
        if (current) {
          await del(pathname, { ifMatch: current.etag }); // deletes are free on every plan
        }
      } else if (current && JSON.stringify(current.data) === JSON.stringify(next)) {
        // Unchanged: skip the write so it doesn't count against the Blob quota.
      } else {
        await put(pathname, JSON.stringify(next), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          cacheControlMaxAge: 60,
          ...(current ? { ifMatch: current.etag } : { allowOverwrite: false }),
        });
      }
      return result;
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && isConflict(error)) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt + Math.random() * 100));
        continue;
      }
      throw error;
    }
  }
}

// ---------- Inbox ----------

interface InboxDoc {
  tracks: Track[];
}

export async function readInbox(userId: number): Promise<Track[]> {
  return (await readDoc<InboxDoc>(path("inbox", userId)))?.data.tracks ?? [];
}

/** Adds a track to a user's inbox; returns false when that file is already waiting there. */
export async function pushToInbox(userId: number, track: Track) {
  return mutateDoc<InboxDoc, boolean>(path("inbox", userId), (current) => {
    const tracks = current?.tracks ?? [];
    const key = track.fileUniqueId ?? track.fileId;
    if (tracks.some((item) => (item.fileUniqueId ?? item.fileId) === key)) {
      return { next: current, result: false };
    }
    return { next: { tracks: [...tracks, track] }, result: true };
  });
}

/** Removes tracks the Mini App has safely copied into CloudStorage. */
export async function acknowledgeInbox(userId: number, trackIds: string[]) {
  const done = new Set(trackIds);
  return mutateDoc<InboxDoc, number>(path("inbox", userId), (current) => {
    const remaining = (current?.tracks ?? []).filter((track) => !done.has(track.id));
    return { next: remaining.length > 0 ? { tracks: remaining } : null, result: remaining.length };
  });
}

// ---------- Groups ----------

export async function readGroup(chatId: string): Promise<GroupLibrary | null> {
  return (await readDoc<GroupLibrary>(path("groups", chatId)))?.data ?? null;
}

export async function mutateGroup<R>(
  chatId: string,
  chatTitle: string | undefined,
  mutate: (current: GroupLibrary) => { next: GroupLibrary; result: R },
) {
  let created = false;
  let title = chatTitle;
  const result = await mutateDoc<GroupLibrary, R>(path("groups", chatId), (current) => {
    created = current === null;
    // Copy, never mutate `current`: mutateDoc compares old vs new to skip no-op writes.
    const base: GroupLibrary = current
      ? { ...current, title: chatTitle ?? current.title }
      : { chatId, title: chatTitle ?? "Group", playlists: [] };
    title = base.title;
    return mutate(base);
  });
  if (created) {
    await registerSharedChat(chatId, title ?? "Group");
  }
  return result;
}

// ---------- Index of chats that have shared playlists ----------
// Lets the Mini App show a user's groups/channels without them having to link each one.

export interface SharedChat {
  chatId: string;
  title: string;
}

interface ChatIndex {
  chats: SharedChat[];
}

async function registerSharedChat(chatId: string, title: string) {
  await mutateDoc<ChatIndex, void>(path("index", "chats"), (current) => {
    const chats = current?.chats ?? [];
    if (chats.some((chat) => chat.chatId === chatId)) {
      return { next: current, result: undefined };
    }
    return { next: { chats: [...chats, { chatId, title }] }, result: undefined };
  });
}

/** All chats with shared playlists. Built once from a listing if the index doesn't exist yet. */
export async function listSharedChats(): Promise<SharedChat[]> {
  const existing = await readDoc<ChatIndex>(path("index", "chats"));
  if (existing) {
    return existing.data.chats;
  }

  const prefix = `${getEnv().dataPrefix}/groups/`;
  const { blobs } = await list({ prefix, limit: 1000 });
  const chats: SharedChat[] = [];
  for (const blob of blobs) {
    const chatId = blob.pathname.slice(prefix.length).replace(/\.json$/, "");
    const group = await readGroup(chatId);
    if (group) {
      chats.push({ chatId, title: group.title });
    }
  }
  await mutateDoc<ChatIndex, void>(path("index", "chats"), (current) => ({
    next: current ?? { chats },
    result: undefined,
  }));
  return chats;
}
