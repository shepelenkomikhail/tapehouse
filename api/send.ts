import { z } from "zod";
import { callTelegram, TelegramApiError } from "../server/bot/telegram-api.js";
import { verifyFileSignature } from "../server/lib/telegram-auth.js";
import { HttpError, requireUser, route } from "./_lib/http.js";

const MAX_TRACKS = 100;

const bodySchema = z.object({
  title: z.string().max(80).optional(),
  tracks: z
    .array(
      z.object({
        fileId: z.string().max(256),
        sig: z.string().max(64),
        kind: z.enum(["audio", "document"]).optional(),
      }),
    )
    .min(1)
    .max(MAX_TRACKS),
});

type Item = z.infer<typeof bodySchema>["tracks"][number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Telegram allows up to 10 files per album, and an album can't mix audio with documents. */
function toAlbums(tracks: Item[]) {
  const albums: Item[][] = [];
  for (const track of tracks) {
    const last = albums.at(-1);
    if (last && last.length < 10 && (last[0].kind ?? "audio") === (track.kind ?? "audio")) {
      last.push(track);
    } else {
      albums.push([track]);
    }
  }
  return albums;
}

async function withRetry<T>(call: () => Promise<T>) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const retryAfter = error instanceof TelegramApiError && error.errorCode === 429
        ? Number(/retry after (\d+)/i.exec(error.message)?.[1] ?? 3)
        : 0;
      if (retryAfter > 0 && retryAfter <= 15 && attempt < 3) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw error;
    }
  }
}

/**
 * POST { title?, tracks } → the bot sends the tracks into the caller's private chat with the bot,
 * in order, so they can be played with Telegram's own player (background play, lock screen, etc.).
 */
export default route(["POST"], async (request) => {
  const user = requireUser(request);
  const body = bodySchema.safeParse(request.body);
  if (!body.success) {
    throw new HttpError(400, `Send between 1 and ${MAX_TRACKS} tracks at a time.`, "too_many");
  }
  if (!body.data.tracks.every((track) => verifyFileSignature(track.fileId, track.sig))) {
    throw new HttpError(400, "Some tracks were not imported through this bot.", "foreign_tracks");
  }

  try {
    if (body.data.title) {
      await callTelegram("sendMessage", { chat_id: user.id, text: `▶️ ${body.data.title}` });
    }

    const albums = toAlbums(body.data.tracks);
    for (const [index, album] of albums.entries()) {
      if (index > 0) {
        await sleep(1100); // stay under Telegram's ~1 message/second per chat
      }
      const type = album[0].kind ?? "audio";
      if (album.length === 1) {
        await withRetry(() =>
          callTelegram(type === "audio" ? "sendAudio" : "sendDocument", {
            chat_id: user.id,
            [type]: album[0].fileId,
          }),
        );
      } else {
        await withRetry(() =>
          callTelegram("sendMediaGroup", {
            chat_id: user.id,
            media: album.map((track) => ({ type, media: track.fileId })),
          }),
        );
      }
    }
  } catch (error) {
    if (error instanceof TelegramApiError && error.errorCode === 403) {
      throw new HttpError(403, "Start a private chat with the bot first, then try again.", "start_bot");
    }
    throw error;
  }

  return { sent: body.data.tracks.length };
});
