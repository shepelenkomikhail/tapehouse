import { z } from "zod";
import type { SearchResponse, Track } from "../shared/types.js";
import { trackFromMessage, type TelegramMessage } from "../server/bot/handlers.js";
import { callTelegram, callTelegramUpload, TelegramApiError } from "../server/bot/telegram-api.js";
import { MAX_UPLOAD_BYTES, resolveTrack, searchMusic, SourceError, type ResolvedTrack } from "../server/lib/music-sources.js";
import { HttpError, queryParam, requireUser, route } from "./_lib/http.js";

const addSchema = z.object({
  source: z.enum(["audius", "archive", "jamendo"]),
  id: z.string().min(1).max(400),
});

/** Sends the file into the user's chat with the bot: by link first, uploading it ourselves if Telegram can't fetch it. */
async function deliver(chatId: number, track: ResolvedTrack) {
  const fields = {
    chat_id: chatId,
    title: track.title.slice(0, 200),
    performer: track.performer.slice(0, 200),
    duration: track.durationSec,
    caption: `${track.performer} — ${track.title}\n${track.license}\n${track.pageUrl}`.slice(0, 1024),
  };

  try {
    return await callTelegram<TelegramMessage>("sendAudio", { ...fields, audio: track.url });
  } catch (error) {
    // 403: the user never started the bot, uploading won't help either.
    if (error instanceof TelegramApiError && error.errorCode === 403) {
      throw error;
    }
    console.warn("sendAudio by URL failed, uploading instead", error instanceof Error ? error.message : error);
  }

  const response = await fetch(track.url, { signal: AbortSignal.timeout(40_000) });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || declared > MAX_UPLOAD_BYTES) {
    throw new HttpError(502, "Couldn't download this track.", "download_failed");
  }
  const data = await response.blob();
  if (data.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(502, "Couldn't download this track.", "download_failed");
  }
  return callTelegramUpload<TelegramMessage>("sendAudio", fields, { field: "audio", data, name: track.fileName });
}

/**
 * GET  ?q=…            → tracks from catalogs whose authors allow downloading.
 * POST { source, id }  → the bot sends that track to the caller's chat; returns it as a Track for the Inbox.
 */
export default route(["GET", "POST"], async (request) => {
  const user = requireUser(request);

  if (request.method === "GET") {
    const query = (queryParam(request, "q") ?? "").trim().slice(0, 100);
    if (query.length < 2) {
      return { results: [], sources: [] } satisfies SearchResponse;
    }
    return (await searchMusic(query)) satisfies SearchResponse;
  }

  const body = addSchema.safeParse(request.body);
  if (!body.success) {
    throw new HttpError(400, "Invalid track.");
  }

  let resolved: ResolvedTrack;
  try {
    resolved = await resolveTrack(body.data.source, body.data.id);
  } catch (error) {
    if (error instanceof SourceError) {
      throw new HttpError(400, error.message, "download_failed");
    }
    throw new HttpError(502, "Couldn't reach the music catalog. Try again.", "download_failed");
  }

  let message: TelegramMessage;
  try {
    message = await deliver(user.id, resolved);
  } catch (error) {
    if (error instanceof TelegramApiError && error.errorCode === 403) {
      throw new HttpError(403, "Start a private chat with the bot first, then try again.", "start_bot");
    }
    if (error instanceof HttpError) {
      throw error;
    }
    console.error("Delivering a found track failed", error);
    throw new HttpError(502, "Couldn't download this track.", "download_failed");
  }

  const track: Track | null = trackFromMessage(message);
  if (!track) {
    throw new HttpError(502, "Couldn't download this track.", "download_failed");
  }
  return { track };
});
