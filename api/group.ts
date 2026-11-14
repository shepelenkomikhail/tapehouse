import type { VercelRequest } from "@vercel/node";
import { z } from "zod";
import { applyPlaylistOp, PlaylistOpError } from "../shared/playlist-ops.js";
import type { GroupLibrary, PlaylistOp } from "../shared/types.js";
import { checkChatMember } from "../server/bot/telegram-api.js";
import { mutateGroup, readGroup } from "../server/lib/blob-store.js";
import { verifyFileSignature } from "../server/lib/telegram-auth.js";
import { HttpError, queryParam, requireUser, route } from "./_lib/http.js";

const trackSchema = z.object({
  id: z.string().max(32),
  title: z.string().max(200),
  performer: z.string().max(200),
  durationSec: z.number().min(0).max(86_400),
  fileId: z.string().max(256),
  fileUniqueId: z.string().max(64).optional(),
  kind: z.enum(["audio", "document"]).optional(),
  sig: z.string().max(64),
  addedAt: z.string().max(40),
});

const id = z.string().max(32);
const opSchema: z.ZodType<PlaylistOp> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("createPlaylist"), title: z.string().max(80), description: z.string().max(200).optional() }),
  z.object({
    op: z.literal("updatePlaylist"),
    playlistId: id,
    title: z.string().max(80).optional(),
    description: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal("deletePlaylist"), playlistId: id }),
  z.object({ op: z.literal("reorder"), playlistId: id, trackIds: z.array(id).max(5000) }),
  z.object({ op: z.literal("shuffle"), playlistId: id }),
  z.object({ op: z.literal("removeTrack"), playlistId: id, trackId: id }),
  z.object({ op: z.literal("addTracks"), playlistId: id, tracks: z.array(trackSchema).max(500) }),
]);

async function requireMembership(request: VercelRequest) {
  const user = requireUser(request);
  const chatId = queryParam(request, "chat");
  if (!chatId || !/^-?\d{1,20}$/.test(chatId)) {
    throw new HttpError(400, "Missing group id.");
  }
  const membership = await checkChatMember(chatId, user.id);
  if (!membership.ok) {
    throw new HttpError(403, "Only members of this group can open its playlists. Is the bot still in the group?");
  }
  return { chatId, chatTitle: membership.title };
}

/**
 * GET  ?chat=ID → the group's shared playlists.
 * POST ?chat=ID → apply one PlaylistOp and return the updated library.
 * Every call checks with Telegram that the caller is a member of that group.
 */
export default route(["GET", "POST"], async (request) => {
  const { chatId, chatTitle } = await requireMembership(request);

  if (request.method === "GET") {
    const group = await readGroup(chatId);
    return group ?? ({ chatId, title: chatTitle ?? "Group", playlists: [] } satisfies GroupLibrary);
  }

  const parsed = opSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid playlist change.");
  }
  const op = parsed.data;

  if (op.op === "addTracks" && !op.tracks.every((track) => verifyFileSignature(track.fileId, track.sig))) {
    throw new HttpError(400, "Some tracks were not imported through this bot.");
  }
  if (op.op === "createPlaylist") {
    const existing = await readGroup(chatId);
    if ((existing?.playlists.length ?? 0) >= 50) {
      throw new HttpError(400, "A group can have up to 50 playlists.");
    }
  }

  try {
    return await mutateGroup(chatId, chatTitle, (group) => {
      const next = { ...group, playlists: applyPlaylistOp(group.playlists, op) };
      return { next, result: next };
    });
  } catch (error) {
    if (error instanceof PlaylistOpError) {
      throw new HttpError(404, error.message);
    }
    throw error;
  }
});
