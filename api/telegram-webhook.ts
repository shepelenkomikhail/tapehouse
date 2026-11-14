import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleTelegramUpdate, type TelegramUpdate } from "../server/bot/handlers.js";
import { getEnv } from "../server/lib/env.js";

function secretMatches(given: string | string[] | undefined, expected: string | undefined) {
  const value = Array.isArray(given) ? given[0] : given;
  if (!value || !expected) {
    return false;
  }
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Telegram → bot updates. Authenticated by the secret_token set in setWebhook. */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed." });
  }
  if (!secretMatches(request.headers["x-telegram-bot-api-secret-token"], getEnv().webhookSecret)) {
    return response.status(401).json({ error: "Invalid webhook secret." });
  }

  try {
    await handleTelegramUpdate(request.body as TelegramUpdate);
  } catch (error) {
    // Still answer 200: otherwise Telegram re-delivers the same update forever and,
    // with max_connections=1, blocks every update behind it.
    console.error("Failed to handle Telegram update", error);
  }
  return response.status(200).json({ ok: true });
}
