import { z } from "zod";
import { HttpError, requireUser, route } from "./_lib/http.js";

const bodySchema = z.object({
  event: z.string().max(60),
  detail: z.string().max(2000),
  client: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

/**
 * POST { event, detail, client } → writes a client-side failure to the function logs
 * (visible with `vercel logs`). Only signed-in Telegram users can report.
 */
export default route(["POST"], async (request) => {
  const user = requireUser(request);
  const body = bodySchema.safeParse(request.body);
  if (!body.success) {
    throw new HttpError(400, "Invalid report.");
  }
  console.warn(
    `[client-error] user=${user.id} event=${body.data.event} detail=${JSON.stringify(body.data.detail)} client=${JSON.stringify(body.data.client ?? {})}`,
  );
  return { ok: true };
});
