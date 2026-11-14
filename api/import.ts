import { z } from "zod";
import type { Track } from "../shared/types.js";
import { addToShared, trackFromMessage, type TelegramMessage } from "../server/bot/handlers.js";
import { callTelegram, checkChatMember, TelegramApiError } from "../server/bot/telegram-api.js";
import { readGroup } from "../server/lib/blob-store.js";
import { HttpError, queryParam, requireUser, route } from "./_lib/http.js";

/**
 * POST ?chat=ID { from, misses } → scans one batch of a channel's (or group's) post history.
 *
 * The Bot API can't list old posts, but a bot that's an admin can forward any post by its number.
 * Each post is forwarded silently into the caller's chat with the bot (that returns the full message,
 * including the audio file_id) and the copy is deleted right away. Audio found is added to the
 * chat's shared playlist in posting order. The Mini App calls this repeatedly until `done`.
 */

const BATCH = 25;
const TIME_BUDGET_MS = 25_000;
/** With no known last post, stop after this many missing post numbers in a row. */
const MAX_MISSES = 150;

const bodySchema = z.object({
  from: z.number().int().min(1).max(10_000_000),
  misses: z.number().int().min(0).max(100_000).default(0),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterSeconds(error: unknown) {
  if (error instanceof TelegramApiError && error.errorCode === 429) {
    return Number(/retry after (\d+)/i.exec(error.message)?.[1] ?? 5);
  }
  return 0;
}

export default route(["POST"], async (request) => {
  const user = requireUser(request);
  const chatId = queryParam(request, "chat");
  if (!chatId || !/^-?\d{1,20}$/.test(chatId)) {
    throw new HttpError(400, "Missing chat id.");
  }
  const body = bodySchema.safeParse(request.body);
  if (!body.success) {
    throw new HttpError(400, "Invalid request.");
  }

  const membership = await checkChatMember(chatId, user.id);
  if (!membership.ok || !membership.admin) {
    throw new HttpError(403, "Only admins of this chat can import its history.", "not_admin");
  }

  // A chat with "restrict saving content" can't be forwarded from at all. Check once up front:
  // individual service posts (e.g. "channel created") also can't be forwarded and are just skipped.
  if (body.data.from === 1) {
    const chat = await callTelegram<{ has_protected_content?: boolean }>("getChat", { chat_id: chatId });
    if (chat.has_protected_content) {
      throw new HttpError(400, "This chat doesn't allow forwarding, so its history can't be imported.", "protected");
    }
  }

  const group = await readGroup(chatId);
  const last = group?.lastMessageId;
  const started = Date.now();
  const found: Track[] = [];
  let id = body.data.from;
  let misses = body.data.misses;
  let retryAfter = 0;

  const isDone = () => (last ? id > last : misses >= MAX_MISSES);

  while (!isDone() && id < body.data.from + BATCH && Date.now() - started < TIME_BUDGET_MS) {
    let forwarded: TelegramMessage | null = null;
    try {
      forwarded = await callTelegram<TelegramMessage>("forwardMessage", {
        chat_id: user.id,
        from_chat_id: chatId,
        message_id: id,
        disable_notification: true,
      });
    } catch (error) {
      const wait = retryAfterSeconds(error);
      if (wait > 0) {
        // Rate limited: stop here and tell the client when to continue with this same post.
        retryAfter = wait;
        break;
      }
      if (error instanceof TelegramApiError && error.errorCode === 403) {
        throw new HttpError(403, "Start a private chat with the bot first, then try again.", "start_bot");
      }
      // Deleted posts, service messages ("can't be forwarded"), gaps in numbering: just skip.
      misses += 1;
      id += 1;
      continue;
    }

    misses = 0;
    const track = trackFromMessage(forwarded);
    if (track) {
      found.push({ ...track, sourceMessageId: id });
    }
    // Remove the temporary copy from the user's chat with the bot.
    await callTelegram("deleteMessage", { chat_id: user.id, message_id: forwarded.message_id }).catch(() => undefined);
    id += 1;
    await sleep(120); // stay well under Telegram's per-chat limits
  }

  let addedCount = 0;
  if (found.length > 0) {
    const chatTitle = membership.title ?? group?.title;
    const type = membership.type === "channel" ? "channel" : "supergroup";
    const result = await addToShared({ id: Number(chatId), type, title: chatTitle }, found, "history");
    addedCount = result.addedCount;
  }

  return {
    next: id,
    misses,
    last: last ?? null,
    found: found.length,
    added: addedCount,
    done: isDone(),
    retryAfter,
  };
});
