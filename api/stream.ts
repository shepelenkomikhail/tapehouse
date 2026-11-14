import { Readable } from "node:stream";
import { resolveFile, TelegramApiError } from "../server/bot/telegram-api.js";
import { verifyFileSignature } from "../server/lib/telegram-auth.js";
import { HttpError, queryParam, route } from "./_lib/http.js";

const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
};

const PASSTHROUGH = ["accept-ranges", "content-length", "content-range", "etag", "last-modified"];

/**
 * GET/HEAD ?f=<file_id>&s=<signature>
 * Proxies audio from Telegram so the bot token never reaches the browser.
 * <audio> can't send auth headers, so access is granted by the per-file signature instead.
 */
export default route(["GET", "HEAD"], async (request, response) => {
  const fileId = queryParam(request, "f");
  const sig = queryParam(request, "s");
  if (!fileId || !sig || !verifyFileSignature(fileId, sig)) {
    throw new HttpError(403, "Invalid stream link.");
  }

  let file;
  try {
    file = await resolveFile(fileId);
  } catch (error) {
    if (error instanceof TelegramApiError && /too big/i.test(error.message)) {
      throw new HttpError(413, "This file is over Telegram's 20 MB streaming limit. Use \"Send to chat\" to play it in Telegram.");
    }
    throw new HttpError(502, "Telegram could not provide this file.");
  }

  const range = request.headers.range;
  const upstream = await fetch(file.url, {
    method: request.method,
    headers: range ? { Range: range } : undefined,
  });
  if (!upstream.ok) {
    throw new HttpError(upstream.status === 416 ? 416 : 502, "Telegram stream failed.");
  }

  response.status(upstream.status);
  for (const header of PASSTHROUGH) {
    const value = upstream.headers.get(header);
    if (value) {
      response.setHeader(header, value);
    }
  }
  // Telegram usually answers application/octet-stream, which iOS Safari refuses to play.
  const extension = file.path.split(".").pop()?.toLowerCase() ?? "";
  response.setHeader("Content-Type", AUDIO_TYPES[extension] ?? "audio/mpeg");
  response.setHeader("Cache-Control", "private, max-age=3600");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body as never);
    body.on("error", reject);
    response.on("close", () => {
      body.destroy(); // listener skipped ahead or closed the app
      resolve();
    });
    body.pipe(response);
  });
});
