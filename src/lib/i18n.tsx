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
  "home.groupEmpty": "Общих плейлистов пока нет. Опубликуйте трек в канале, импортируйте старую музыку или ответьте /save@{botName} на трек в группе.",
  "home.howToAdd": "Как подключить группу или канал",
  "home.importChat": "Импортировать всю музыку",
  "home.nowPlaying": "Сейчас играет",
  "home.language": "Язык",
  "inbox.title": "Входящие",
  "inbox.description": "Сюда попадают треки, которые вы отправляете боту.",
  "playlist.my": "Мой плейлист",
  "playlist.group": "Группа",
  "playlist.back": "Назад",
  "playlist.options": "Настройки плейлиста",
  "playlist.play": "Слушать",
  "playlist.shuffle": "Перемешать",
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
  "sheet.rename": "Название и обложка",
  "sheet.cover": "Обложка",
  "sheet.noEmoji": "Без эмодзи — первая буква названия",
  "sheet.customEmoji": "Или вставьте любой эмодзи",
  "sheet.sendAll": "Отправить всё в чат",
  "sheet.sortNewest": "Сортировать: сначала новые",
  "sheet.sortOldest": "Сортировать: сначала старые",
  "toast.sorted": "Порядок сохранён",
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
  "playlist.stop": "Остановить",
  "playlist.loadingMore": "Загружаются остальные треки… Уже загруженные можно слушать.",
  "playlist.shuffleAllHint": "Играть всю музыку в случайном порядке",
  "all.title": "Вся музыка",
  "all.description": "Все треки из всех ваших плейлистов, групп и каналов. Каждый трек один раз.",
  "all.context": "Все плейлисты",
  "all.empty": "Здесь появятся треки из всех ваших плейлистов.",
  "sheet.addAllTo": "Добавить все треки в другой плейлист…",
  "sheet.addAllTitle": "Добавить все треки в…",
  "sheet.merge": "Объединить с другими плейлистами…",
  "merge.title": "Объединить плейлисты",
  "merge.explain": "Отметьте плейлисты. В «Моих плейлистах» появится новый плейлист со всеми их треками, без повторов. Исходные плейлисты не изменятся.",
  "merge.name": "Название нового плейлиста",
  "merge.create": "Создать объединённый плейлист",
  "merge.pickTwo": "Отметьте хотя бы два плейлиста",
  "toast.merged": "Создан «{title}»: {count}",
  "toast.addedAll": "В «{title}» добавлено: {count}",
  "toast.allAlreadyIn": "Все треки уже есть в «{title}»",
  "home.info": "Инструкция",
  "info.title": "Как пользоваться Tapehouse",
  "info.addTitle": "Как добавить музыку",
  "info.addBody":
    "• Отправьте или перешлите аудиофайлы боту {bot}. Они попадут во «Входящие».\n• Кнопка «Добавить музыку» вверху открывает чат с ботом.\n• Лупа вверху — «Найти музыку» (демо): поиск свободной музыки, которую авторы разрешили скачивать. Найденный трек бот пришлёт вам в чат, и он появится во «Входящих».\n• Плейлисты хранятся в вашем облаке Telegram, а сами файлы остаются на серверах Telegram.",
  "info.playlistsTitle": "Плейлисты",
  "info.playlistsBody":
    "• «Новый плейлист» под списком создаёт плейлист.\n• «⋯» у трека: «Добавить в плейлист…», «Отправить в чат», «Убрать из этого плейлиста».\n• Тяните трек за ручку слева, чтобы поменять порядок.\n• «⋯» вверху плейлиста: название, описание и эмодзи-обложка, сортировка по дате добавления, отправка всех треков в чат, удаление.\n• Поиск появляется, когда в плейлисте больше 6 треков.",
  "info.mergeTitle": "Объединение и копирование",
  "info.mergeBody":
    "• «⋯» вверху плейлиста → «Объединить с другими плейлистами…»: отметьте нужные, и появится новый плейлист со всеми их треками. Исходные не меняются.\n• «⋯» → «Добавить все треки в другой плейлист…» копирует весь плейлист в выбранный.\n• Повторы пропускаются: один и тот же файл не попадёт в плейлист дважды.",
  "info.allTitle": "Вся музыка",
  "info.allBody":
    "• Первая строка в списке: все треки из всех ваших плейлистов, групп и каналов в одном месте.\n• Трек, который лежит в нескольких плейлистах, показывается один раз.\n• Сверху самые новые. «Перемешать» играет всё вразнобой.\n• Это сборный список, его нельзя редактировать: меняйте исходные плейлисты.",
  "info.listenTitle": "Прослушивание",
  "info.listenBody":
    "• «Слушать» запускает плейлист. Пока музыка играет, кнопка называется «Остановить».\n• Нажмите на трек, чтобы включить его, и ещё раз, чтобы поставить на паузу.\n• «Перемешать» на плейлисте сохраняет новый порядок (один исполнитель не звучит дважды подряд). Кнопка перемешивания в плеере внизу играет вразнобой, не меняя порядок плейлиста.\n• Tapehouse помнит, где вы остановились, даже если открыть его на другом устройстве.\n• Файлы больше 20 МБ здесь не играют (ограничение Telegram). Нажмите «В чат», и бот пришлёт треки для встроенного плеера Telegram.",
  "info.groupsTitle": "Группы и каналы",
  "info.groupsBody":
    "• Добавляйте бота {bot} сразу администратором. Обычным подписчиком бота в канал добавить нельзя: Telegram этого не позволяет, и бот не увидит посты.\n• Канал: настройки канала → Администраторы → Добавить администратора → найдите {bot}. Каждый новый аудиопост сам попадёт в общий плейлист канала.\n• Группа: тоже добавьте бота администратором. Ответьте /save@{botName} на трек, чтобы добавить его в плейлист группы, /inbox@{botName} — чтобы сохранить в свои «Входящие». /playlists@{botName} пришлёт кнопку с плейлистами.\n• Музыку, опубликованную раньше, добавит «Импортировать всю музыку». Импортировать может любой участник (админом должен быть только бот); не работает, если в чате запрещена пересылка.\n• Группа или канал появляется здесь сам, если вы его участник. Убрать из списка: «⋯» на его плейлисте → «Скрыть эту группу из списка».\n• Общие плейлисты видят и меняют все участники. Их треки не попадают во «Входящие», но есть во «Вся музыка».",
  "info.otherTitle": "Прочее",
  "info.otherBody":
    "• RU / EN вверху переключает язык.\n• Если что-то не загрузилось, закройте и снова откройте Tapehouse.",
  "info.close": "Понятно",
  "find.open": "Найти музыку",
  "find.title": "Найти музыку",
  "find.demo": "Демо. Ищем только музыку, которую авторы разрешили скачивать: Creative Commons и свободные треки. Популярных хитов здесь нет.",
  "find.placeholder": "Исполнитель, трек или жанр",
  "find.search": "Найти",
  "find.searching": "Ищем…",
  "find.nothing": "Ничего не нашлось. Попробуйте другие слова, например жанр: lofi, jazz, piano.",
  "find.preview": "Послушать отрывок",
  "find.stopPreview": "Остановить",
  "find.add": "Скачать во «Входящие»",
  "find.adding": "Скачиваем…",
  "find.added": "Во «Входящих»",
  "find.sources": "Источники: {sources}",
  "toast.found": "«{title}» во «Входящих», файл в чате с ботом",
  "err.download_failed": "Не удалось скачать этот трек. Попробуйте другой.",
  "unit.track": "трек|трека|треков",
  "unit.newTrack": "новый трек|новых трека|новых треков",
  "unit.song": "песня|песни|песен",
  "unit.copy": "лишняя копия|лишние копии|лишних копий",
  "sheet.duplicates": "Найти дубликаты",
  "dupes.title": "Дубликаты",
  "dupes.loading": "Плейлист ещё загружается. Откройте проверку, когда загрузятся все треки.",
  "dupes.none": "Дубликатов не найдено.",
  "dupes.close": "Готово",
  "dupes.found": "Повторяются {songs}, всего {copies}. Дубликат — тот же файл или то же название и исполнитель (без учёта регистра). Отмеченные будут удалены, первая копия остаётся.",
  "dupes.allNote": "Во «Вся музыка» удаление убирает трек из всех плейлистов, где он есть, включая общие плейлисты групп и каналов.",
  "dupes.keep": "оставить",
  "dupes.remove": "удалить",
  "dupes.removeSelected": "Удалить отмеченные ({count})",
  "dupes.keepAll": "Не удалять",
  "toast.dupesRemoved": "Удалено дубликатов: {count}",
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
  "home.groupEmpty": "No shared playlists yet. Post a track in the channel, import older music, or reply /save@{botName} to a track in the group.",
  "home.howToAdd": "How to connect a group or channel",
  "home.importChat": "Import all music",
  "home.nowPlaying": "Now playing",
  "home.language": "Language",
  "inbox.title": "Inbox",
  "inbox.description": "Tracks you send to the bot land here.",
  "playlist.my": "My playlist",
  "playlist.group": "Group",
  "playlist.back": "Back",
  "playlist.options": "Playlist options",
  "playlist.play": "Play",
  "playlist.shuffle": "Shuffle",
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
  "sheet.rename": "Name and cover",
  "sheet.cover": "Cover",
  "sheet.noEmoji": "No emoji: first letter of the name",
  "sheet.customEmoji": "Or paste any emoji",
  "sheet.sendAll": "Send all to chat",
  "sheet.sortNewest": "Sort: newest first",
  "sheet.sortOldest": "Sort: oldest first",
  "toast.sorted": "Order saved",
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
  "playlist.stop": "Stop",
  "playlist.loadingMore": "Loading the rest of the tracks… The ones here can already play.",
  "playlist.shuffleAllHint": "Play all your music in random order",
  "all.title": "All music",
  "all.description": "Every track from all your playlists, groups and channels. Each track once.",
  "all.context": "All playlists",
  "all.empty": "Tracks from all your playlists will show up here.",
  "sheet.addAllTo": "Add all tracks to another playlist…",
  "sheet.addAllTitle": "Add all tracks to…",
  "sheet.merge": "Merge with other playlists…",
  "merge.title": "Merge playlists",
  "merge.explain": "Tick the playlists. A new playlist with all their tracks, without duplicates, appears in My playlists. The originals stay as they are.",
  "merge.name": "New playlist name",
  "merge.create": "Create merged playlist",
  "merge.pickTwo": "Tick at least two playlists",
  "toast.merged": "Created “{title}”: {count}",
  "toast.addedAll": "Added to “{title}”: {count}",
  "toast.allAlreadyIn": "All tracks are already in “{title}”",
  "home.info": "How it works",
  "info.title": "How to use Tapehouse",
  "info.addTitle": "Adding music",
  "info.addBody":
    "• Send or forward audio files to {bot}. They land in your Inbox.\n• “Add music” at the top opens the chat with the bot.\n• The magnifier at the top is “Find music” (demo): search free music its authors allow to download. The bot sends the track to your chat and it appears in your Inbox.\n• Playlists are stored in your Telegram cloud; the files themselves stay on Telegram's servers.",
  "info.playlistsTitle": "Playlists",
  "info.playlistsBody":
    "• “New playlist” under the list creates one.\n• “⋯” on a track: “Add to playlist…”, “Send to chat”, “Remove from this playlist”.\n• Drag a track by the handle on the left to reorder.\n• “⋯” at the top of a playlist: name, description and emoji cover, sort by date added, send all tracks to chat, delete.\n• Search appears when a playlist has more than 6 tracks.",
  "info.mergeTitle": "Merging and copying",
  "info.mergeBody":
    "• “⋯” at the top of a playlist → “Merge with other playlists…”: tick the ones you want and a new playlist with all their tracks appears. The originals don't change.\n• “⋯” → “Add all tracks to another playlist…” copies the whole playlist into the one you pick.\n• Duplicates are skipped: the same file never goes into a playlist twice.",
  "info.allTitle": "All music",
  "info.allBody":
    "• The first row in the list: every track from all your playlists, groups and channels in one place.\n• A track that sits in several playlists shows up once.\n• Newest first. “Shuffle” plays everything in random order.\n• It's built automatically and can't be edited: change the original playlists instead.",
  "info.listenTitle": "Listening",
  "info.listenBody":
    "• “Play” starts a playlist. While it plays, the button reads “Stop”.\n• Tap a track to play it, tap it again to pause.\n• “Shuffle” on a playlist saves a new order (the same artist never plays twice in a row). The shuffle button in the player below plays in random order without changing the playlist.\n• Tapehouse remembers where you stopped, even on another device.\n• Files over 20 MB can't play here (a Telegram limit). Use “Send to chat” and the bot sends them for Telegram's own player.",
  "info.groupsTitle": "Groups and channels",
  "info.groupsBody":
    "• Add {bot} as an admin right away. A bot can't join a channel as a regular subscriber: Telegram doesn't allow it, and the bot wouldn't see the posts.\n• Channel: channel settings → Administrators → Add admin → find {bot}. Every new audio post goes into the channel's shared playlist by itself.\n• Group: add the bot as an admin too. Reply /save@{botName} to a track to add it to the group playlist, /inbox@{botName} to save it to your own Inbox. /playlists@{botName} posts a button with the playlists.\n• “Import all music” adds what was posted earlier. Any member can import (only the bot has to be an admin); it doesn't work in chats that forbid forwarding.\n• A group or channel shows up here by itself when you're a member. To remove it: “⋯” on its playlist → “Hide this group from my list”.\n• All members can see and edit shared playlists. Their tracks don't go to your Inbox, but they are in All music.",
  "info.otherTitle": "Other",
  "info.otherBody":
    "• RU / EN at the top switches the language.\n• If something doesn't load, close and reopen Tapehouse.",
  "info.close": "Got it",
  "find.open": "Find music",
  "find.title": "Find music",
  "find.demo": "Demo. Only music its authors allow to download is searched: Creative Commons and free tracks. Chart hits aren't here.",
  "find.placeholder": "Artist, track or genre",
  "find.search": "Search",
  "find.searching": "Searching…",
  "find.nothing": "Nothing found. Try other words, e.g. a genre: lofi, jazz, piano.",
  "find.preview": "Listen to a preview",
  "find.stopPreview": "Stop",
  "find.add": "Download to Inbox",
  "find.adding": "Downloading…",
  "find.added": "In Inbox",
  "find.sources": "Sources: {sources}",
  "toast.found": "“{title}” is in your Inbox, the file is in your chat with the bot",
  "err.download_failed": "Couldn't download this track. Try another one.",
  "unit.track": "track|tracks|tracks",
  "unit.newTrack": "new track|new tracks|new tracks",
  "unit.song": "song|songs|songs",
  "unit.copy": "extra copy|extra copies|extra copies",
  "sheet.duplicates": "Find duplicates",
  "dupes.title": "Duplicates",
  "dupes.loading": "This playlist is still loading. Check again once all its tracks are in.",
  "dupes.none": "No duplicates found.",
  "dupes.close": "Done",
  "dupes.found": "{songs} repeat, {copies} in total. A duplicate is the same file, or the same title and artist (ignoring case). Ticked tracks get removed; the first copy stays.",
  "dupes.allNote": "In All music, removing a track takes it out of every playlist it's in, including shared group and channel playlists.",
  "dupes.keep": "keep",
  "dupes.remove": "remove",
  "dupes.removeSelected": "Remove ticked ({count})",
  "dupes.keepAll": "Keep all",
  "toast.dupesRemoved": "Duplicates removed: {count}",
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
  return (count: number, unitKey: "unit.track" | "unit.newTrack" | "unit.song" | "unit.copy") => {
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
