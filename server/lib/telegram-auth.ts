import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "../../shared/types.js";
import { getEnv, requireBotToken } from "./env.js";

/** Telegram re-signs initData on every Mini App launch; reject anything older than this. */
const MAX_INIT_DATA_AGE_SEC = 7 * 24 * 60 * 60;

export class AuthError extends Error {}

function safeEqualHex(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Validates Mini App initData as described in
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * and returns the Telegram user it was issued to.
 */
export function verifyInitData(initData: string, botToken: string): SessionUser {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw new AuthError("initData has no hash.");
  }
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!safeEqualHex(expected, hash.toLowerCase())) {
    throw new AuthError("initData signature is invalid.");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SEC) {
    throw new AuthError("initData has expired. Reopen the Mini App.");
  }

  const rawUser = params.get("user");
  const user = rawUser ? (JSON.parse(rawUser) as { id?: number; first_name?: string; username?: string }) : null;
  if (!user?.id) {
    throw new AuthError("initData has no user.");
  }

  return { id: user.id, firstName: user.first_name ?? "Telegram user", username: user.username };
}

/** Reads `Authorization: tma <initData>` and returns the verified Telegram user. */
export function authenticate(authorizationHeader: string | undefined): SessionUser {
  const env = getEnv();
  const header = authorizationHeader?.trim() ?? "";

  if (header.startsWith("tma ")) {
    return verifyInitData(header.slice(4), requireBotToken());
  }

  if (env.devUser) {
    const [id, firstName] = env.devUser.split(":");
    return { id: Number(id), firstName: firstName || "Dev user" };
  }

  throw new AuthError("Open Tapehouse from Telegram.");
}

/**
 * Stream URLs are signed so `/api/stream` only proxies files that came through this bot.
 * Uses TAPEHOUSE_SIGNING_SECRET so rotating the bot token doesn't invalidate saved tracks;
 * falls back to a key derived from the bot token when it isn't set.
 */
export function signFileId(fileId: string) {
  const key = createHmac("sha256", "tapehouse-stream")
    .update(getEnv().signingSecret ?? requireBotToken())
    .digest();
  return createHmac("sha256", key).update(fileId).digest("base64url").slice(0, 22);
}

export function verifyFileSignature(fileId: string, sig: string) {
  const expected = Buffer.from(signFileId(fileId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
