import { getEnv, requireBotToken } from "../lib/env.js";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
  ) {
    super(message);
  }
}

export async function callTelegram<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${TELEGRAM_API}/bot${requireBotToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = (await response.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };

  if (!result.ok) {
    throw new TelegramApiError(result.description ?? `Telegram ${method} failed.`, result.error_code);
  }
  return result.result as T;
}

// Function instances are reused between requests, so small in-memory caches cut Telegram calls.
const fileCache = new Map<string, { url: string; size?: number; path: string; expires: number }>();
const memberCache = new Map<string, { ok: boolean; admin: boolean; title?: string; type?: string; expires: number }>();
let botUsernameCache: string | undefined;

/** Resolves a file_id to a download URL. Fails for files over 20 MB (Bot API limit). */
export async function resolveFile(fileId: string) {
  const cached = fileCache.get(fileId);
  if (cached && cached.expires > Date.now()) {
    return cached;
  }

  const file = await callTelegram<{ file_path?: string; file_size?: number }>("getFile", {
    file_id: fileId,
  });
  if (!file.file_path) {
    throw new TelegramApiError("Telegram returned no file path.");
  }

  // Telegram guarantees the link for at least one hour.
  const entry = {
    url: `${TELEGRAM_API}/file/bot${requireBotToken()}/${file.file_path}`,
    size: file.file_size,
    path: file.file_path,
    expires: Date.now() + 50 * 60 * 1000,
  };
  fileCache.set(fileId, entry);
  return entry;
}

/** True when the user is currently a member of the chat. Cached for a few minutes. */
export async function checkChatMember(chatId: string, userId: number) {
  const key = `${chatId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached;
  }

  let ok = false;
  let admin = false;
  let title: string | undefined;
  let type: string | undefined;
  try {
    const member = await callTelegram<{ status: string; is_member?: boolean }>("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
    ok =
      ["creator", "administrator", "member"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true);
    admin = member.status === "creator" || member.status === "administrator";
    if (ok) {
      const chat = await callTelegram<{ title?: string; type?: string }>("getChat", { chat_id: chatId });
      title = chat.title;
      type = chat.type;
    }
  } catch {
    ok = false; // bot not in chat, chat gone, etc.
  }

  // Short negative cache so adding the bot / joining takes effect quickly.
  const entry = { ok, admin, title, type, expires: Date.now() + (ok ? 5 * 60 * 1000 : 20 * 1000) };
  memberCache.set(key, entry);
  return entry;
}

export async function getBotUsername() {
  const fromEnv = getEnv().botUsername;
  if (fromEnv) {
    return fromEnv;
  }
  if (!botUsernameCache) {
    botUsernameCache = (await callTelegram<{ username?: string }>("getMe", {})).username;
  }
  return botUsernameCache;
}

/** Mini App URL for `web_app` buttons (only allowed in private chats). */
export function buildMiniAppUrl(params?: Record<string, string>) {
  const url = new URL(getEnv().appUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * t.me link that opens the bot's Main Mini App. Works in groups, where web_app buttons are
 * not allowed. Requires "Main Mini App" to be enabled for the bot in BotFather.
 */
export async function buildStartAppLink(startParam?: string) {
  const username = await getBotUsername();
  const url = new URL(`https://t.me/${username}`);
  url.searchParams.set("startapp", startParam ?? "home");
  return url.toString();
}

/** Start params use only [A-Za-z0-9_-]; group ids are negative, e.g. g-1001234567890. */
export function groupStartParam(chatId: string) {
  return `g${chatId}`;
}
