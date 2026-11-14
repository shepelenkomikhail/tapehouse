import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadSetting, saveSetting } from "./cloud-storage";

export type Lang = "ru" | "en";

/** Default Inbox names; a user-renamed Inbox keeps its own name instead of being translated. */
export const DEFAULT_INBOX_TITLES = new Set(["Inbox", "Входящие"]);
export const DEFAULT_INBOX_DESCRIPTIONS = new Set([
  "Tracks you send to the bot land here.",
  "Сюда попадают треки, которые вы отправляете боту.",
]);
export const LANGS: Lang[] = ["ru", "en"];
const DEFAULT_LANG: Lang = "ru";

/** Russian has three plural forms: 1 трек, 2 трека, 5 треков. */
function pluralRu(n: number, [one, few, many]: [string, string, string]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const ru = {
  "lang.name": "Русский",
  "app.loading": "Загрузка…",
  "app.openFromTelegram": "Откройте Tapehouse из вашего Telegram-бота.",
  "app.cantReach": "Не удалось подключиться к Tapehouse.",
  "app.cantLoad": "Не удалось загрузить плейлисты из Telegram.",
  "home.greeting": "Привет, {name}",
  "home.previewMode": " · режим просмотра, сохраняется только в этом браузере",
  "home.addMusic": "Добавить музыку",
  "home.myPlaylists": "Мои плейлисты",
  "home.emptyHint":
    "Перешлите или отправьте аудиофайлы боту {bot}. Они попадут во «Входящие», откуда их можно разложить по плейлистам. Всё хранится в вашем аккаунте Telegram.",
  "home.newPlaylist": "Новый плейлист",
  "home.playlistName": "Название плейлиста",
  "home.create": "Создать",
  "home.loading": "Загрузка…",
  "home.sharedTitle": "Группы и каналы",
  "home.sharedHint":
    "Добавьте {bot} администратором в группу или канал.\n• Канал: каждый аудиофайл, который вы публикуете, автоматически попадает в общий плейлист, и канал появится здесь. Старые треки перешлите боту из канала.\n• Группа: ответьте на трек командой /save@{botName}, бот пришлёт кнопку для открытия плейлистов.",
  "home.groupEmpty": "Общих плейлистов пока нет. Опубликуйте трек в канале или ответьте /save@{botName} на трек в группе.",
  "home.howToAdd": "Как подключить группу или канал",
  "home.nowPlaying": "Сейчас играет",
  "home.language": "Язык",
  "inbox.title": "Входящие",
  "inbox.description": "Сюда попадают треки, которые вы отправляете боту.",
  "playlist.my": "Мой плейлист",
  "playlist.group": "Группа",
  "playlist.back": "Назад",
  "playlist.options": "Настройки плейлиста",
  "playlist.play": "Слушать",
  "playlist.shuffle": "Перемешать список",
  "playlist.shuffleHint": "Меняет порядок так, чтобы один исполнитель не звучал дважды подряд",
  "playlist.send": "В чат",
  "playlist.sending": "Отправка…",
  "playlist.sendHint": "Бот пришлёт эти треки вам в чат, для встроенного плеера Telegram",
  "playlist.search": "Поиск в плейлисте",
  "playlist.empty": "Треков пока нет. Нажмите «⋯» у любого трека во «Входящих» → «Добавить в плейлист», или отправьте аудио боту.",
  "playlist.pick": "Выберите плейлист, чтобы увидеть треки.",
  "track.move": "Переместить «{title}»",
  "track.more": "Действия для «{title}»",
  "sheet.addToPlaylist": "Добавить в плейлист…",
  "sheet.sendToChat": "Отправить в чат",
  "sheet.removeFromPlaylist": "Убрать из этого плейлиста",
  "sheet.addTitle": "Добавить в плейлист",
  "sheet.createFirst": "Сначала создайте ещё один плейлист.",
  "sheet.rename": "Переименовать",
  "sheet.sendAll": "Отправить всё в чат",
  "sheet.hideGroup": "Скрыть эту группу из списка",
  "sheet.importHistory": "Импортировать всю музыку из чата",
  "import.title": "Импорт истории",
  "import.explain":
    "Бот просмотрит все посты по порядку и добавит найденные треки в плейлист. Посты на секунду пересылаются в ваш чат с ботом и сразу удаляются. Не закрывайте приложение до конца импорта.",
  "import.start": "Начать",
  "import.stop": "Остановить",
  "import.close": "Готово",
  "import.progress": "Просмотрено постов: {scanned}{of}",
  "import.of": " из {last}",
  "import.found": "Найдено треков: {found}, новых добавлено: {added}",
  "import.waiting": "Telegram просит подождать {seconds} с…",
  "import.done": "Импорт завершён",
  "import.stopped": "Импорт остановлен",
  "sheet.deletePlaylist": "Удалить плейлист",
  "sheet.editTitle": "Редактировать плейлист",
  "sheet.name": "Название",
  "sheet.description": "Описание",
  "sheet.save": "Сохранить",
  "player.label": "Плеер",
  "player.seek": "Перемотка",
  "player.prev": "Предыдущий",
  "player.next": "Следующий",
  "player.play": "Играть",
  "player.pause": "Пауза",
  "player.shuffle": "Случайный порядок",
  "player.shuffleHint": "Играть в случайном порядке, не меняя порядок плейлиста",
  "player.error": "Не удалось воспроизвести трек здесь (файлы больше 20 МБ не стримятся). Нажмите «В чат», чтобы слушать в Telegram.",
  "toast.newTracks": "Во «Входящих» {count}",
  "toast.inboxSaveFailed": "Новые треки пришли, но не сохранились: {detail}. Попробуем снова при следующем открытии.",
  "toast.cloudSaveFailed": "Не удалось сохранить в облако Telegram: {detail}",
  "toast.sentFirst": "Отправлены первые {count} в чат с ботом",
  "toast.sent": "Отправлено в чат с ботом: {count}",
  "toast.sentOne": "Отправлено в чат с ботом",
  "toast.addedTo": "Добавлено в «{title}»",
  "toast.alreadyIn": "Уже есть в «{title}»",
  "confirm.delete": "Удалить «{title}»? Это нельзя отменить.",
  "unit.track": "трек|трека|треков",
  "unit.newTrack": "новый трек|новых трека|новых треков",
  "unit.min": "мин",
  "unit.h": "ч",
  "err.not_member": "Плейлисты этого чата доступны только его участникам. Бот всё ещё в чате?",
  "err.foreign_tracks": "Некоторые треки добавлены не через этого бота.",
  "err.start_bot": "Сначала откройте личный чат с ботом и нажмите «Старт», затем попробуйте снова.",
  "err.file_too_big": "Файл больше 20 МБ, лимит Telegram для стриминга. Нажмите «В чат», чтобы слушать в Telegram.",
  "err.unauthorized": "Откройте Tapehouse из Telegram.",
  "err.expired": "Сессия устарела. Закройте и снова откройте Tapehouse.",
  "err.not_found": "Плейлист не найден. Возможно, его удалили.",
  "err.too_many": "Слишком много треков за раз.",
  "err.limit": "Достигнут лимит плейлистов для чата.",
  "err.generic": "Что-то пошло не так. Попробуйте ещё раз.",
  "err.not_admin": "Импортировать историю могут только администраторы чата.",
  "err.protected": "В этом чате запрещена пересылка, поэтому историю импортировать нельзя.",
};

type Key = keyof typeof ru;

const en: Record<Key, string> = {
  "lang.name": "English",
  "app.loading": "Loading…",
  "app.openFromTelegram": "Open Tapehouse from your Telegram bot to use it.",
  "app.cantReach": "Couldn't reach Tapehouse.",
  "app.cantLoad": "Couldn't load your playlists from Telegram.",
  "home.greeting": "Hi, {name}",
  "home.previewMode": " · preview mode, saved in this browser only",
  "home.addMusic": "Add music",
  "home.myPlaylists": "My playlists",
  "home.emptyHint":
    "Forward or send audio files to {bot}. They land in your Inbox here, ready to sort into playlists. Everything is stored in your Telegram account.",
  "home.newPlaylist": "New playlist",
  "home.playlistName": "Playlist name",
  "home.create": "Create",
  "home.loading": "Loading…",
  "home.sharedTitle": "Groups & channels",
  "home.sharedHint":
    "Add {bot} as an admin to a group or channel.\n• Channel: every audio you post goes into its shared playlist automatically, and the channel shows up here. Forward older tracks from the channel to the bot.\n• Group: reply /save@{botName} to a track and the bot posts a button that opens the playlists.",
  "home.groupEmpty": "No shared playlists yet. Post a track in the channel, or reply /save@{botName} to a track in the group.",
  "home.howToAdd": "How to connect a group or channel",
  "home.nowPlaying": "Now playing",
  "home.language": "Language",
  "inbox.title": "Inbox",
  "inbox.description": "Tracks you send to the bot land here.",
  "playlist.my": "My playlist",
  "playlist.group": "Group",
  "playlist.back": "Back",
  "playlist.options": "Playlist options",
  "playlist.play": "Play",
  "playlist.shuffle": "Shuffle list",
  "playlist.shuffleHint": "Reorders the playlist, keeping the same artist from playing twice in a row",
  "playlist.send": "Send to chat",
  "playlist.sending": "Sending…",
  "playlist.sendHint": "The bot sends these tracks to your chat, for Telegram's own player",
  "playlist.search": "Search in playlist",
  "playlist.empty": "No tracks yet. Use “⋯” → “Add to playlist” on any track in your Inbox, or send audio to the bot.",
  "playlist.pick": "Pick a playlist to see its tracks.",
  "track.move": "Move {title}",
  "track.more": "More actions for {title}",
  "sheet.addToPlaylist": "Add to playlist…",
  "sheet.sendToChat": "Send to chat",
  "sheet.removeFromPlaylist": "Remove from this playlist",
  "sheet.addTitle": "Add to playlist",
  "sheet.createFirst": "Create another playlist first.",
  "sheet.rename": "Rename",
  "sheet.sendAll": "Send all to chat",
  "sheet.hideGroup": "Hide this group from my list",
  "sheet.importHistory": "Import all music from the chat",
  "import.title": "Import history",
  "import.explain":
    "The bot goes through every post in order and adds the tracks it finds to the playlist. Posts are forwarded to your chat with the bot for a moment and deleted right away. Keep the app open until it finishes.",
  "import.start": "Start",
  "import.stop": "Stop",
  "import.close": "Done",
  "import.progress": "Posts checked: {scanned}{of}",
  "import.of": " of {last}",
  "import.found": "Tracks found: {found}, new added: {added}",
  "import.waiting": "Telegram asks to wait {seconds}s…",
  "import.done": "Import finished",
  "import.stopped": "Import stopped",
  "sheet.deletePlaylist": "Delete playlist",
  "sheet.editTitle": "Edit playlist",
  "sheet.name": "Name",
  "sheet.description": "Description",
  "sheet.save": "Save",
  "player.label": "Player",
  "player.seek": "Seek",
  "player.prev": "Previous",
  "player.next": "Next",
  "player.play": "Play",
  "player.pause": "Pause",
  "player.shuffle": "Shuffle play",
  "player.shuffleHint": "Play in random order without changing the playlist's order",
  "player.error": "Couldn't play this track here (files over 20 MB can't stream). Use “Send to chat” to play it in Telegram.",
  "toast.newTracks": "{count} in your Inbox",
  "toast.inboxSaveFailed": "New tracks arrived but couldn't be saved: {detail}. They'll retry next time.",
  "toast.cloudSaveFailed": "Couldn't save to your Telegram cloud: {detail}",
  "toast.sentFirst": "Sent the first {count} to your chat with the bot",
  "toast.sent": "Sent to your chat with the bot: {count}",
  "toast.sentOne": "Sent to your chat with the bot",
  "toast.addedTo": "Added to “{title}”",
  "toast.alreadyIn": "Already in “{title}”",
  "confirm.delete": "Delete “{title}”? This can't be undone.",
  "unit.track": "track|tracks|tracks",
  "unit.newTrack": "new track|new tracks|new tracks",
  "unit.min": "min",
  "unit.h": "h",
  "err.not_member": "Only members of this chat can open its playlists. Is the bot still there?",
  "err.foreign_tracks": "Some tracks were not imported through this bot.",
  "err.start_bot": "Open a private chat with the bot and press Start, then try again.",
  "err.file_too_big": "This file is over Telegram's 20 MB streaming limit. Use “Send to chat” to play it in Telegram.",
  "err.unauthorized": "Open Tapehouse from Telegram.",
  "err.expired": "Your session expired. Close and reopen Tapehouse.",
  "err.not_found": "Playlist not found. It may have been deleted.",
  "err.too_many": "Too many tracks at once.",
  "err.limit": "This chat has reached its playlist limit.",
  "err.generic": "Something went wrong. Try again.",
  "err.not_admin": "Only admins of this chat can import its history.",
  "err.protected": "This chat doesn't allow forwarding, so its history can't be imported.",
};

const dictionaries: Record<Lang, Record<Key, string>> = { ru, en };

export type T = (key: Key, vars?: Record<string, string | number>) => string;

function translate(lang: Lang): T {
  return (key, vars) => {
    let text = dictionaries[lang][key] ?? ru[key] ?? key;
    for (const [name, value] of Object.entries(vars ?? {})) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
}

/** "5 треков" / "5 tracks". `unitKey` holds "one|few|many" forms. */
function makeCount(lang: Lang, t: T) {
  return (count: number, unitKey: "unit.track" | "unit.newTrack") => {
    const forms = t(unitKey).split("|") as [string, string, string];
    const word = lang === "ru" ? pluralRu(count, forms) : count === 1 ? forms[0] : forms[1];
    return `${count} ${word}`;
  };
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: T;
  count: ReturnType<typeof makeCount>;
  runtime: (seconds: number) => string;
}

const I18nContext = createContext<I18n | null>(null);

function readLocal(): Lang | null {
  try {
    const value = localStorage.getItem("tapehouse:lang");
    return value === "ru" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readLocal() ?? DEFAULT_LANG);

  // The choice is synced through Telegram CloudStorage so it follows the user across devices.
  useEffect(() => {
    loadSetting("lang")
      .then((value) => {
        if (value === "ru" || value === "en") {
          setLangState(value);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem("tapehouse:lang", next);
    } catch {
      /* private mode */
    }
    void saveSetting("lang", next).catch(() => undefined);
  }, []);

  const value = useMemo<I18n>(() => {
    const t = translate(lang);
    return {
      lang,
      setLang,
      t,
      count: makeCount(lang, t),
      runtime: (seconds) => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.round((seconds % 3600) / 60);
        return hours > 0
          ? `${hours} ${t("unit.h")} ${minutes} ${t("unit.min")}`
          : `${minutes} ${t("unit.min")}`;
      },
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}

/** Turns an API error code into a translated message, falling back to the server's text. */
export function errorMessage(t: T, error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code) {
    const key = `err.${code}` as Key;
    if (key in ru) {
      return t(key);
    }
  }
  return error instanceof Error && error.message ? error.message : t("err.generic");
}
