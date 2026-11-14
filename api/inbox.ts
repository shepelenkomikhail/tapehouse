import { z } from "zod";
import type { InboxResponse } from "../shared/types.js";
import { getBotUsername } from "../server/bot/telegram-api.js";
import { acknowledgeInbox, readInbox } from "../server/lib/blob-store.js";
import { HttpError, requireUser, route } from "./_lib/http.js";

const ackSchema = z.object({ trackIds: z.array(z.string().max(32)).max(1000) });

/**
 * GET  → who the caller is + tracks the bot collected for them.
 * POST → { trackIds } the client has copied into CloudStorage; they are removed from the inbox.
 */
export default route(["GET", "POST"], async (request) => {
  const user = requireUser(request);

  if (request.method === "GET") {
    const [inbox, botUsername] = await Promise.all([readInbox(user.id), getBotUsername()]);
    return { user, botUsername, inbox } satisfies InboxResponse;
  }

  const body = ackSchema.safeParse(request.body);
  if (!body.success) {
    throw new HttpError(400, "Invalid request.");
  }
  const remaining = await acknowledgeInbox(user.id, body.data.trackIds);
  return { remaining };
});
