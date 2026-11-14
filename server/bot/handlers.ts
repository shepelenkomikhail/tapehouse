import { appendUniqueTracks, createPlaylist, makeId } from "../../shared/playlist-ops.js";
import type { Track } from "../../shared/types.js";
import { mutateGroup, pushToInbox } from "../lib/blob-store.js";
import { signFileId } from "../lib/telegram-auth.js";
import {
  buildMiniAppUrl,
  buildStartAppLink,
  callTelegram,
  checkChatMember,
  getBotUsername,
  groupStartParam,
} from "./telegram-api.js";

interface TelegramUser {
  id: number;
  first_name?: string;
  is_bot?: boolean;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  reply_to_message?: TelegramMessage;
  /** Set when the message was forwarded; for channel posts it names the channel. */
  forward_origin?: { type: "user" | "hidden_user" | "chat" | "channel"; chat?: TelegramChat; sender_chat?: TelegramChat };
  audio?: {
    file_id: string;
    file_unique_id?: string;
    title?: string;
    performer?: string;
    duration?: number;
    file_name?: string;
  };
  document?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

// ---------- Texts (Russian by default, English for English-language Telegram users) ----------

type Lang = "ru" | "en";

const TEXT = {
  ru: {
    openApp: "Открыть Tapehouse",
    openShared: (title: string) => `Открыть плейлисты «${title}»`,
    openGroup: "Открыть плейлисты группы",
    savedInbox: (track: string, where: string) => `«${track}» сохранён во «Входящие»${where}. Откройте Tapehouse, чтобы разложить по плейлистам.`,
    alreadyInbox: (track: string, where: string) => `«${track}» уже ждёт во «Входящих»${where}.`,
    whoseInbox: (name: string) => ` (${name})`,
    addedGroup: (track: string, playlist: string) => `«${track}» добавлен в «${playlist}».`,
    alreadyGroup: (track: string, playlist: string) => `«${track}» уже есть в «${playlist}».`,
    replyTo: (command: string) => `Ответьте /${command} на сообщение с аудиофайлом.`,
    start: (name: string) =>
      `Привет, ${name}! Отправляйте или пересылайте мне аудиофайлы, и я соберу их во «Входящие». ` +
      "Откройте Tapehouse, чтобы превратить их в плейлисты.",
    helpPrivate:
      "Как работает Tapehouse:\n\n" +
      "1. Перешлите или отправьте мне любой аудиофайл, он попадёт во «Входящие».\n" +
      "2. Откройте Tapehouse: раскладывайте треки по плейлистам, меняйте порядок, перемешивайте и слушайте.\n" +
      "3. «В чат» на плейлисте пришлёт треки сюда, для встроенного плеера Telegram.\n\n" +
      "Группы и каналы: добавьте меня администратором. В канале каждый опубликованный трек сам попадает в общий плейлист. " +
      "Чтобы открыть его, перешлите мне любой пост из канала.",
    helpGroup: (bot: string) =>
      "Tapehouse в группах:\n\n" +
      `• Ответьте /save@${bot} на трек, чтобы добавить его в общий плейлист группы.\n` +
      `• Ответьте /inbox@${bot}, чтобы сохранить трек в свои «Входящие».\n` +
      `• /playlists@${bot} пришлёт кнопку для открытия плейлистов группы.`,
    sharedFound: (title: string) => `Вот общие плейлисты «${title}»:`,
    notMember: (title: string) =>
      `Плейлисты «${title}» доступны только участникам. Если это ваш канал, добавьте меня туда администратором.`,
  },
  en: {
    openApp: "Open Tapehouse",
    openShared: (title: string) => `Open “${title}” playlists`,
    openGroup: "Open group playlists",
    savedInbox: (track: string, where: string) => `Saved "${track}" to the Inbox${where}. Open Tapehouse to sort it into playlists.`,
    alreadyInbox: (track: string, where: string) => `"${track}" is already waiting in the Inbox${where}.`,
    whoseInbox: (name: string) => ` (${name})`,
    addedGroup: (track: string, playlist: string) => `Added "${track}" to "${playlist}".`,
    alreadyGroup: (track: string, playlist: string) => `"${track}" is already in "${playlist}".`,
    replyTo: (command: string) => `Reply /${command} to a message that contains an audio file.`,
    start: (name: string) =>
      `Hi ${name}! Send or forward me audio files and I'll collect them into your Inbox. ` +
      "Open Tapehouse to turn them into playlists.",
    helpPrivate:
      "How Tapehouse works:\n\n" +
      "1. Forward or send me any audio file. It goes to your Inbox.\n" +
      "2. Open Tapehouse to sort tracks into playlists, reorder, shuffle and play them.\n" +
      "3. \"Send to chat\" on a playlist sends it back here for Telegram's own player.\n\n" +
      "Groups and channels: add me as an admin. In a channel, every track you post goes into its shared playlist. " +
      "To open it, forward me any post from the channel.",
    helpGroup: (bot: string) =>
      "Tapehouse in groups:\n\n" +
      `• Reply /save@${bot} to a track to add it to the group's shared playlist.\n` +
      `• Reply /inbox@${bot} to save a track to your own Inbox.\n` +
      `• /playlists@${bot} posts a button that opens the group's playlists.`,
    sharedFound: (title: string) => `Here are the shared playlists of “${title}”:`,
    notMember: (title: string) =>
      `Only members can open “${title}” playlists. If it's your channel, add me there as an admin.`,
  },
};

function langOf(user?: TelegramUser): Lang {
  return user?.language_code?.toLowerCase().startsWith("en") ? "en" : "ru";
}

// ---------- Helpers ----------

const COMMAND_PATTERN = /^\/([a-z_]+)(?:@([\w_]+))?(?:\s|$)/i;

function isGroup(chat: TelegramChat) {
  return chat.type === "group" || chat.type === "supergroup";
}

async function parseCommand(text?: string) {
  const match = text?.match(COMMAND_PATTERN);
  if (!match) {
    return null;
  }
  // In groups, ignore commands addressed to a different bot.
  const target = match[2]?.toLowerCase();
  if (target && target !== (await getBotUsername())?.toLowerCase()) {
    return null;
  }
  return match[1].toLowerCase();
}

async function mentionsBot(text?: string) {
  const username = await getBotUsername();
  return Boolean(text && username && text.toLowerCase().includes(`@${username.toLowerCase()}`));
}

function splitLabel(raw?: string) {
  const name = raw?.replace(/\.[^/.]+$/, "").replace(/_/g, " ").trim();
  if (!name) {
    return { title: "Untitled track", performer: "Unknown artist" };
  }
  const parts = name.split(/\s+[—–-]\s+/);
  if (parts.length >= 2) {
    return { performer: parts[0].trim(), title: parts.slice(1).join(" – ").trim() };
  }
  return { title: name, performer: "Unknown artist" };
}

/** Extracts a playable track from an audio message or an audio file sent as a document. */
function trackFromMessage(message: TelegramMessage): Track | null {
  const now = new Date().toISOString();

  if (message.audio) {
    const fallback = splitLabel(message.audio.file_name);
    return {
      id: makeId(),
      title: message.audio.title || fallback.title,
      performer: message.audio.performer || fallback.performer,
      durationSec: message.audio.duration ?? 0,
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      sig: signFileId(message.audio.file_id),
      addedAt: now,
    };
  }

  const doc = message.document;
  const isAudioDoc =
    doc &&
    (doc.mime_type?.toLowerCase().startsWith("audio/") ||
      /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus)$/i.test(doc.file_name ?? ""));
  if (!doc || !isAudioDoc) {
    return null;
  }

  const label = splitLabel(doc.file_name);
  return {
    id: makeId(),
    title: label.title,
    performer: label.performer,
    durationSec: 0,
    fileId: doc.file_id,
    fileUniqueId: doc.file_unique_id,
    sig: signFileId(doc.file_id),
    kind: "document",
    addedAt: now,
  };
}

type Button = { text: string; web_app?: { url: string }; url?: string };

/** Button that opens a chat's shared playlists: web_app in private chats, t.me link in groups. */
async function sharedButton(where: TelegramChat, sharedChatId: string, text: string): Promise<Button> {
  const param = groupStartParam(sharedChatId);
  return where.type === "private"
    ? { text, web_app: { url: buildMiniAppUrl({ startapp: param }) } }
    : { text, url: await buildStartAppLink(param) };
}

async function defaultButtons(message: TelegramMessage): Promise<Button[]> {
  const t = TEXT[langOf(message.from)];
  return isGroup(message.chat)
    ? [await sharedButton(message.chat, String(message.chat.id), t.openGroup)]
    : [{ text: t.openApp, web_app: { url: buildMiniAppUrl() } }];
}

async function reply(message: TelegramMessage, text: string, buttons?: Button[] | null) {
  const rows = buttons === null ? [] : (buttons ?? (await defaultButtons(message))).map((button) => [button]);
  await callTelegram("sendMessage", {
    chat_id: message.chat.id,
    text,
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(rows.length > 0 ? { reply_markup: { inline_keyboard: rows } } : {}),
  });
}

/** The group or channel a forwarded message came from, if any. */
function forwardedFromChat(message: TelegramMessage): TelegramChat | null {
  const origin = message.forward_origin;
  const chat = origin?.type === "channel" ? origin.chat : origin?.type === "chat" ? origin.sender_chat : undefined;
  return chat && chat.type !== "private" ? chat : null;
}

/** Extra button that opens the shared playlists of the chat a message was forwarded from. */
async function forwardedChatButton(message: TelegramMessage): Promise<{ button: Button; title: string } | { denied: string } | null> {
  const source = forwardedFromChat(message);
  if (!source || !message.from) {
    return null;
  }
  const membership = await checkChatMember(String(source.id), message.from.id);
  const title = membership.title ?? source.title ?? "Chat";
  if (!membership.ok) {
    return { denied: title };
  }
  return {
    button: await sharedButton(message.chat, String(source.id), TEXT[langOf(message.from)].openShared(title)),
    title,
  };
}

// ---------- Actions ----------

async function saveToInbox(message: TelegramMessage, track: Track) {
  if (!message.from) {
    return;
  }
  const t = TEXT[langOf(message.from)];
  const added = await pushToInbox(message.from.id, track);
  const where = isGroup(message.chat) ? t.whoseInbox(message.from.first_name ?? "") : "";

  const buttons = await defaultButtons(message);
  const shared = await forwardedChatButton(message);
  if (shared && "button" in shared) {
    buttons.push(shared.button);
  }
  await reply(message, added ? t.savedInbox(track.title, where) : t.alreadyInbox(track.title, where), buttons);
}

/** Adds a track to the first shared playlist of a group or channel (creating it if needed). */
async function addToShared(chat: TelegramChat, track: Track) {
  const chatId = String(chat.id);
  return mutateGroup(chatId, chat.title, (group) => {
    const playlists =
      group.playlists.length > 0
        ? [...group.playlists]
        : [createPlaylist(chat.type === "channel" && chat.title ? chat.title : "Shared queue")];
    const target = appendUniqueTracks(playlists[0], [track]);
    playlists[0] = { ...target.playlist, updatedAt: new Date().toISOString() };
    return {
      next: { ...group, playlists },
      result: { title: playlists[0].title, added: target.addedCount > 0 },
    };
  });
}

async function saveToGroup(message: TelegramMessage, track: Track) {
  const t = TEXT[langOf(message.from)];
  const { title, added } = await addToShared(message.chat, track);
  await reply(message, added ? t.addedGroup(track.title, title) : t.alreadyGroup(track.title, title));
}

async function handleChannelPost(post: TelegramMessage) {
  // Every track posted in a channel where the bot is admin goes into the channel's playlist.
  // Nothing is posted back: the channel stays clean.
  const track = trackFromMessage(post);
  if (track) {
    await addToShared(post.chat, track);
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.channel_post) {
    await handleChannelPost(update.channel_post);
    return;
  }

  const message = update.message;
  if (!message?.from || message.from.is_bot) {
    return;
  }
  const t = TEXT[langOf(message.from)];
  const command = await parseCommand(message.text ?? message.caption);

  if (command === "start" && message.chat.type === "private") {
    await reply(message, t.start(message.from.first_name ?? ""));
    return;
  }
  if (command === "help" || command === "start") {
    await reply(message, isGroup(message.chat) ? t.helpGroup((await getBotUsername()) ?? "bot") : t.helpPrivate);
    return;
  }
  if (command === "playlists" && isGroup(message.chat)) {
    await reply(message, t.sharedFound(message.chat.title ?? ""));
    return;
  }

  if (command === "save" || command === "inbox") {
    const source = message.reply_to_message ?? message;
    const track = trackFromMessage(source);
    if (!track) {
      await reply(message, t.replyTo(command), null);
      return;
    }
    if (command === "save" && isGroup(message.chat)) {
      await saveToGroup(message, track);
    } else {
      await saveToInbox(message, track);
    }
    return;
  }

  const track = trackFromMessage(message);

  if (message.chat.type === "private") {
    const source = forwardedFromChat(message);
    if (track && source) {
      // Forwarding from a channel/group you administer (with the bot in it) backfills that
      // chat's shared playlist: the bot can't read channel history by itself.
      const membership = await checkChatMember(String(source.id), message.from.id);
      if (membership.ok && membership.admin) {
        const chat = { ...source, title: membership.title ?? source.title };
        const { title, added } = await addToShared(chat, track);
        await reply(message, added ? t.addedGroup(track.title, title) : t.alreadyGroup(track.title, title), [
          await sharedButton(message.chat, String(source.id), t.openShared(chat.title ?? title)),
        ]);
        return;
      }
    }
    if (track) {
      await saveToInbox(message, track);
      return;
    }
    // A forwarded post without audio: offer to open that channel's / group's playlists.
    const shared = await forwardedChatButton(message);
    if (shared && "button" in shared) {
      await reply(message, t.sharedFound(shared.title), [shared.button]);
    } else if (shared && "denied" in shared) {
      await reply(message, t.notMember(shared.denied), null);
    }
    return;
  }

  if (track && isGroup(message.chat) && (await mentionsBot(message.caption))) {
    await saveToGroup(message, track);
  }
}
