import { z } from "zod";
import type { InboxResponse } from "../shared/types.js";
import { checkChatMember, getBotUsername } from "../server/bot/telegram-api.js";
import { acknowledgeInbox, listSharedChats, readInbox } from "../server/lib/blob-store.js";
import { HttpError, requireUser, route } from "./_lib/http.js";

const ackSchema = z.object({ trackIds: z.array(z.string().max(32)).max(1000) });

/** Shared chats the user belongs to, checked with Telegram (cached). Never fails the request. */
async function memberChats(userId: number) {
  try {
    const chats = (await listSharedChats()).slice(0, 50);
    const checks = await Promise.all(
      chats.map(async (chat) => {
        const membership = await checkChatMember(chat.chatId, userId);
        return membership.ok ? { chatId: chat.chatId, title: membership.title ?? chat.title } : null;
      }),
    );
    return checks.filter((chat): chat is { chatId: string; title: string } => chat !== null);
  } catch (error) {
    console.error("Shared chat lookup failed", error);
    return [];
  }
}

/**
 * GET  → who the caller is + tracks the bot collected for them.
 * POST → { trackIds } the client has copied into CloudStorage; they are removed from the inbox.
 */
export default route(["GET", "POST"], async (request) => {
  const user = requireUser(request);

  if (request.method === "GET") {
    const [inbox, botUsername, sharedChats] = await Promise.all([
      readInbox(user.id),
      getBotUsername(),
      memberChats(user.id),
    ]);
    return { user, botUsername, inbox, sharedChats } satisfies InboxResponse;
  }

  const body = ackSchema.safeParse(request.body);
  if (!body.success) {
    throw new HttpError(400, "Invalid request.");
  }
  const remaining = await acknowledgeInbox(user.id, body.data.trackIds);
  return { remaining };
});
