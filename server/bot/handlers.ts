import { appendUniqueTracks, createPlaylist, makeId } from "../../shared/playlist-ops.js";
import type { Track } from "../../shared/types.js";
import { mutateGroup, pushToInbox } from "../lib/blob-store.js";
import { signFileId } from "../lib/telegram-auth.js";
import {
  buildMiniAppUrl,
  buildStartAppLink,
  callTelegram,
  getBotUsername,
  groupStartParam,
} from "./telegram-api.js";

interface TelegramUser {
  id: number;
  first_name?: string;
  is_bot?: boolean;
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
}

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

async function openAppMarkup(chat: TelegramChat) {
  const button = isGroup(chat)
    ? { text: "Open group playlists", url: await buildStartAppLink(groupStartParam(String(chat.id))) }
    : { text: "Open Tapehouse", web_app: { url: buildMiniAppUrl() } };
  return { inline_keyboard: [[button]] };
}

async function reply(message: TelegramMessage, text: string, withButton = true) {
  await callTelegram("sendMessage", {
    chat_id: message.chat.id,
    text,
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(withButton ? { reply_markup: await openAppMarkup(message.chat) } : {}),
  });
}

async function saveToInbox(message: TelegramMessage, track: Track) {
  if (!message.from) {
    return;
  }
  const added = await pushToInbox(message.from.id, track);
  const where = isGroup(message.chat) ? `${message.from.first_name ?? "Your"}'s Inbox` : "your Inbox";
  await reply(
    message,
    added
      ? `Saved "${track.title}" to ${where}. Open Tapehouse to sort it into playlists.`
      : `"${track.title}" is already waiting in ${where}.`,
  );
}

async function saveToGroup(message: TelegramMessage, track: Track) {
  const chatId = String(message.chat.id);
  const { title, added } = await mutateGroup(chatId, message.chat.title, (group) => {
    const playlists = group.playlists.length > 0 ? [...group.playlists] : [createPlaylist("Shared queue")];
    const target = appendUniqueTracks(playlists[0], [track]);
    playlists[0] = { ...target.playlist, updatedAt: new Date().toISOString() };
    return {
      next: { ...group, playlists },
      result: { title: playlists[0].title, added: target.addedCount > 0 },
    };
  });

  await reply(
    message,
    added ? `Added "${track.title}" to "${title}".` : `"${track.title}" is already in "${title}".`,
  );
}

async function sendHelp(message: TelegramMessage) {
  const username = await getBotUsername();
  const text = isGroup(message.chat)
    ? "Tapehouse in groups:\n\n" +
      `• Reply /save@${username} to any track to add it to this group's shared playlist.\n` +
      `• Reply /inbox@${username} to save a track to your own Inbox instead.\n` +
      `• Or mention @${username} in the caption when you upload a track.\n\n` +
      "Tap the button below to open the group's playlists."
    : "How Tapehouse works:\n\n" +
      "1. Forward or send me any audio file. It goes to your Inbox.\n" +
      "2. Open Tapehouse to sort tracks into playlists, reorder, shuffle and play them.\n" +
      "3. Tap \"Send to chat\" on a playlist to get it back here as audio messages for Telegram's own player.\n\n" +
      "Add me to a group to build shared playlists with friends.";
  await reply(message, text);
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message?.from || message.from.is_bot) {
    return;
  }

  const command = await parseCommand(message.text ?? message.caption);

  if (command === "start" || command === "help") {
    if (command === "start" && message.chat.type === "private") {
      await reply(
        message,
        `Hi ${message.from.first_name ?? "there"}! Send or forward me audio files and I'll collect them ` +
          "into your Inbox. Open Tapehouse to turn them into playlists.",
      );
      return;
    }
    await sendHelp(message);
    return;
  }

  if (command === "save" || command === "inbox") {
    const source = message.reply_to_message ?? message;
    const track = trackFromMessage(source);
    if (!track) {
      await reply(message, `Reply /${command} to a message that contains an audio file.`, false);
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
  if (!track) {
    return;
  }

  if (message.chat.type === "private") {
    await saveToInbox(message, track);
  } else if (isGroup(message.chat) && (await mentionsBot(message.caption))) {
    await saveToGroup(message, track);
  }
}
