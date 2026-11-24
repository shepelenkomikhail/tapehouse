import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { applyPlaylistOp, makeId, normalizeEmoji, PlaylistOpError } from "../shared/playlist-ops";
import type { GroupLibrary, Playlist, PlaylistOp, SessionUser, Track } from "../shared/types";
import { Home, type GroupView } from "./components/Home";
import { Cover } from "./components/Cover";
import { Icon } from "./components/Icon";
import { ImportSheet } from "./components/ImportSheet";
import { InfoSheet } from "./components/InfoSheet";
import { MergeSheet, type PlaylistChoice } from "./components/MergeSheet";
import { PlayerBar } from "./components/PlayerBar";
import { PlaylistScreen } from "./components/PlaylistScreen";
import { Sheet, SheetButton } from "./components/Sheet";
import { ALL_REF, sameRef, usePlayer, type PlaylistRef } from "./hooks/usePlayer";
import { api, ApiError } from "./lib/api";
import { cloudSelfTest, isSyncedStorage } from "./lib/cloud-storage";
import { DEFAULT_INBOX_DESCRIPTIONS, DEFAULT_INBOX_TITLES, errorMessage, useI18n } from "./lib/i18n";
import { loadLibrary, mergeInbox, persistLibrary, type PersonalLibrary } from "./lib/library";
import { confirmAction, getStartParam, getWebApp, haptic, initTelegram, openBotChat } from "./lib/telegram";

type Target = { kind: "personal" } | { kind: "group"; chatId: string };
type SheetState =
  | { type: "track"; ref: PlaylistRef; track: Track }
  | { type: "copy"; ref: PlaylistRef; track: Track }
  | { type: "playlist"; ref: PlaylistRef }
  | { type: "copyAll"; ref: PlaylistRef }
  | { type: "merge"; ref: PlaylistRef }
  | { type: "rename"; ref: PlaylistRef }
  | { type: "import"; chatId: string }
  | { type: "info" };

const MAX_SEND = 100;
/** Most tracks one group request accepts (see api/group.ts); bigger copies go in batches. */
const GROUP_BATCH = 500;
const trackKey = (track: Track) => track.fileUniqueId ?? track.fileId;

export default function App() {
  const { t, count } = useI18n();
  // Callbacks created once (startup, persistence) read the current language through this ref.
  const tRef = useRef(t);
  tRef.current = t;
  const countRef = useRef(count);
  countRef.current = count;
  const errorText = useCallback((error: unknown) => errorMessage(tRef.current, error), []);

  const [session, setSession] = useState<{ user: SessionUser; botUsername?: string } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [library, setLibrary] = useState<PersonalLibrary | null>(null);
  const libraryRef = useRef<PersonalLibrary | null>(null);
  const [groups, setGroups] = useState<Record<string, GroupView>>({});
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [view, setView] = useState<PlaylistRef | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    (error ? haptic.error : haptic.success)();
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), toast.error ? 5000 : 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ---------- Data access ----------

  /**
   * "All music": every track of every personal and shared playlist, each file once, newest first.
   * Built on the fly, so it never costs storage and is always up to date.
   */
  const allMusic = useMemo<Playlist>(() => {
    const seen = new Set<string>();
    const tracks: Track[] = [];
    const sources = [
      ...(library?.playlists ?? []),
      ...(library?.groups ?? []).flatMap((known) => {
        const group = groups[known.chatId];
        return group?.status === "ready" ? group.playlists : [];
      }),
    ];
    for (const playlist of sources) {
      for (const track of playlist.tracks) {
        if (!seen.has(trackKey(track))) {
          seen.add(trackKey(track));
          tracks.push(track);
        }
      }
    }
    const ordered = tracks
      .map((track, index) => ({ track, index, time: Date.parse(track.addedAt) || 0 }))
      .sort((a, b) => b.time - a.time || a.index - b.index)
      .map(({ track }) => track);
    return { id: "all", title: "All music", description: "", accent: "#5b5bd6", createdAt: "", updatedAt: "", tracks: ordered };
  }, [library?.playlists, library?.groups, groups]);

  const resolve = useCallback(
    (ref: PlaylistRef): Playlist | undefined => {
      if (ref.kind === "all") {
        return allMusic;
      }
      if (ref.kind === "personal") {
        return library?.playlists.find((playlist) => playlist.id === ref.playlistId);
      }
      return groups[ref.chatId]?.playlists.find((playlist) => playlist.id === ref.playlistId);
    },
    [library, groups, allMusic],
  );

  const player = usePlayer(resolve);

  /** Replace the personal library and persist the difference to Telegram CloudStorage. */
  const commitPersonal = useCallback(
    (next: PersonalLibrary) => {
      const previous = libraryRef.current;
      libraryRef.current = next;
      setLibrary(next);
      if (previous) {
        persistLibrary(previous, next).catch((error) => {
          notify(tRef.current("toast.cloudSaveFailed", { detail: errorText(error) }), true);
          void api
            .report("persist", error instanceof Error ? error.message : String(error), {
              version: getWebApp()?.version ?? null,
              platform: getWebApp()?.platform ?? null,
            })
            .catch(() => undefined);
        });
      }
    },
    [notify, errorText],
  );

  const setGroup = useCallback((chatId: string, patch: Partial<GroupView>) => {
    setGroups((current) => {
      const base: GroupView = current[chatId] ?? { chatId, title: "Group", playlists: [], status: "loading" };
      return { ...current, [chatId]: { ...base, ...patch } };
    });
  }, []);

  const applyGroup = useCallback(
    (data: GroupLibrary) => setGroup(data.chatId, { title: data.title, playlists: data.playlists, status: "ready" }),
    [setGroup],
  );

  const loadGroup = useCallback(
    async (chatId: string) => {
      setGroup(chatId, { status: "loading" });
      try {
        const data = await api.getGroup(chatId);
        applyGroup(data);
        return data;
      } catch (error) {
        setGroup(chatId, { status: "error", error: errorText(error) });
        return null;
      }
    },
    [applyGroup, setGroup, errorText],
  );

  /** Re-reads a group without the loading state, so an open playlist doesn't flicker. */
  const refreshGroup = useCallback(
    async (chatId: string) => {
      try {
        applyGroup(await api.getGroup(chatId));
      } catch {
        /* next refresh will catch up */
      }
    },
    [applyGroup],
  );

  /** Apply a playlist operation to a personal or group library. Returns the resulting playlists. */
  const runOp = useCallback(
    async (target: Target, op: PlaylistOp): Promise<Playlist[] | null> => {
      if (target.kind === "personal") {
        const current = libraryRef.current;
        if (!current) {
          return null;
        }
        try {
          const playlists = applyPlaylistOp(current.playlists, op);
          const inboxDeleted = op.op === "deletePlaylist" && op.playlistId === current.inboxId;
          commitPersonal({ ...current, playlists, inboxId: inboxDeleted ? null : current.inboxId });
          return playlists;
        } catch (error) {
          notify(error instanceof PlaylistOpError ? error.message : errorText(error), true);
          return null;
        }
      }

      const group = groupsRef.current[target.chatId];
      // Optimistic update for edits whose result we can predict exactly.
      if (group && (op.op === "reorder" || op.op === "sortByAdded" || op.op === "removeTrack" || op.op === "updatePlaylist")) {
        try {
          setGroup(target.chatId, { playlists: applyPlaylistOp(group.playlists, op) });
        } catch {
          /* server will report */
        }
      }
      try {
        const data = await api.groupOp(target.chatId, op);
        applyGroup(data);
        return data.playlists;
      } catch (error) {
        notify(errorText(error), true);
        void loadGroup(target.chatId);
        return null;
      }
    },
    [applyGroup, commitPersonal, loadGroup, notify, setGroup, errorText],
  );

  /** Where a playlist's changes go; "All music" is built automatically and has none. */
  const targetOf = (ref: PlaylistRef): Target | null =>
    ref.kind === "personal" ? { kind: "personal" } : ref.kind === "group" ? { kind: "group", chatId: ref.chatId } : null;

  const runOpOn = (ref: PlaylistRef, op: PlaylistOp) => {
    const target = targetOf(ref);
    return target ? runOp(target, op) : Promise.resolve(null);
  };

  // ---------- Startup ----------

  const started = useRef(false);
  useEffect(() => {
    // Run once, even under React StrictMode's double effects in development.
    if (started.current) {
      return;
    }
    started.current = true;
    initTelegram();

    (async () => {
      let lib: PersonalLibrary;
      try {
        lib = await loadLibrary();
      } catch (error) {
        setFatal(`${tRef.current("app.cantLoad")} ${errorText(error)}`);
        return;
      }
      libraryRef.current = lib;
      setLibrary(lib);

      let inbox: Track[] = [];
      let sharedChats: { chatId: string; title: string }[] = [];
      try {
        const response = await api.getInbox();
        setSession({ user: response.user, botUsername: response.botUsername });
        inbox = response.inbox;
        sharedChats = response.sharedChats ?? [];
      } catch (error) {
        setFatal(
          error instanceof ApiError && error.status === 401
            ? error.code === "expired"
              ? tRef.current("err.expired")
              : tRef.current("app.openFromTelegram")
            : `${tRef.current("app.cantReach")} ${errorText(error)}`,
        );
        return;
      }

      if (inbox.length > 0) {
        const merged = mergeInbox(libraryRef.current!, inbox, {
          title: tRef.current("inbox.title"),
          description: tRef.current("inbox.description"),
        });
        const previous = libraryRef.current!;
        libraryRef.current = merged.library;
        setLibrary(merged.library);
        let step = "persist";
        try {
          // Only clear the server inbox once the tracks are safely in CloudStorage.
          await persistLibrary(previous, merged.library);
          step = "ack";
          await api.ackInbox(inbox.map((track) => track.id));
          if (merged.added > 0) {
            notify(tRef.current("toast.newTracks", { count: countRef.current(merged.added, "unit.newTrack") }));
          }
        } catch (error) {
          console.error("Inbox save failed", error);
          notify(tRef.current("toast.inboxSaveFailed", { detail: errorText(error) }), true);
          // Send the exact failure to the server log so it can be diagnosed.
          const webApp = getWebApp();
          const selfTest = step === "persist" ? await cloudSelfTest().catch((e) => String(e)) : "skipped";
          void api
            .report(`inbox-${step}`, error instanceof Error ? `${error.name}: ${error.message}` : String(error), {
              version: webApp?.version ?? null,
              platform: webApp?.platform ?? null,
              tracks: inbox.length,
              playlists: previous.playlists.length,
              selfTest,
            })
            .catch(() => undefined);
        }
      }

      const startParam = getStartParam();
      // g<chatId> opens a chat's playlists; i<chatId> (from the "bot added" message) also opens the import.
      const startMatch = startParam?.match(/^([gi])(-?\d+)$/);
      const startGroup = startMatch?.[2];
      const startImport = startMatch?.[1] === "i";

      // Groups/channels with shared playlists that you're a member of appear automatically.
      if (libraryRef.current) {
        const current = libraryRef.current;
        const knownIds = new Set(current.groups.map((group) => group.chatId));
        const hidden = new Set(current.hiddenGroups.filter((chatId) => chatId !== startGroup));
        const discovered = sharedChats.filter((chat) => !knownIds.has(chat.chatId) && !hidden.has(chat.chatId));
        if (discovered.length > 0 || hidden.size !== current.hiddenGroups.length) {
          commitPersonal({ ...current, groups: [...current.groups, ...discovered], hiddenGroups: [...hidden] });
        }
      }
      const known = libraryRef.current?.groups ?? [];

      for (const group of known) {
        if (group.chatId !== startGroup) {
          void loadGroup(group.chatId);
        }
      }

      if (startGroup) {
        const data = await loadGroup(startGroup);
        if (data && libraryRef.current) {
          const others = libraryRef.current.groups.filter((group) => group.chatId !== startGroup);
          commitPersonal({ ...libraryRef.current, groups: [...others, { chatId: startGroup, title: data.title }] });
          const main = data.playlists.find((playlist) => playlist.id === data.mainPlaylistId) ?? data.playlists[0];
          if (main) {
            setView({ kind: "group", chatId: startGroup, playlistId: main.id });
          }
          if (startImport) {
            setSheet({ type: "import", chatId: startGroup });
          }
        }
      }
    })();
  }, [commitPersonal, loadGroup, notify, errorText]);

  // Telegram's native back button mirrors our in-app back arrow on phones.
  useEffect(() => {
    const backButton = getWebApp()?.BackButton;
    if (!backButton) {
      return;
    }
    const back = () => (sheet ? setSheet(null) : setView(null));
    if (view || sheet) {
      backButton.show();
      backButton.onClick(back);
    } else {
      backButton.hide();
    }
    return () => backButton.offClick(back);
  }, [view, sheet]);

  useEffect(() => {
    if (player.state.error) {
      notify(t("player.error"), true);
      player.clearError();
    }
  }, [player, notify, t]);

  // ---------- Derived ----------

  const groupList = useMemo(
    () =>
      (library?.groups ?? []).map(
        (known) =>
          groups[known.chatId] ?? { chatId: known.chatId, title: known.title, playlists: [], status: "loading" as const },
      ),
    [library?.groups, groups],
  );

  const current = view ? resolve(view) : undefined;
  const isInbox = (ref: PlaylistRef) => ref.kind === "personal" && ref.playlistId === library?.inboxId;
  const titleOf = (ref: PlaylistRef) => {
    if (ref.kind === "all") {
      return t("all.title");
    }
    const stored = resolve(ref)?.title ?? "";
    return isInbox(ref) && DEFAULT_INBOX_TITLES.has(stored) ? t("inbox.title") : stored;
  };
  const currentContext =
    view?.kind === "group"
      ? groups[view.chatId]?.title ?? t("playlist.group")
      : view?.kind === "all"
        ? t("all.context")
        : view && isInbox(view)
        ? t("inbox.title")
        : t("playlist.my");

  // If the open playlist disappears (deleted elsewhere), fall back to home.
  useEffect(() => {
    if (view && library && !resolve(view) && (view.kind !== "group" || groups[view.chatId]?.status === "ready")) {
      setView(null);
    }
  }, [view, library, groups, resolve]);

  // ---------- Actions ----------

  const createPlaylist = async (target: Target, title: string) => {
    const before = new Set(
      (target.kind === "personal" ? library?.playlists : groups[target.chatId]?.playlists)?.map((p) => p.id),
    );
    const result = await runOp(target, { op: "createPlaylist", title });
    const created = result?.find((playlist) => !before.has(playlist.id));
    if (created) {
      setView(target.kind === "personal"
        ? { kind: "personal", playlistId: created.id }
        : { kind: "group", chatId: target.chatId, playlistId: created.id });
    }
  };

  const shuffle = async () => {
    if (!view) {
      return;
    }
    if (view.kind === "all") {
      // Can't be reordered: play everything in a random order instead.
      haptic.select();
      player.playShuffled(view);
      return;
    }
    setBusy("shuffle");
    await runOpOn(view, { op: "shuffle", playlistId: view.playlistId });
    setBusy(null);
    haptic.success();
  };

  const sendToChat = async (ref: PlaylistRef) => {
    const playlist = resolve(ref);
    if (!playlist || playlist.tracks.length === 0) {
      return;
    }
    const tracks = playlist.tracks.slice(0, MAX_SEND);
    setBusy("send");
    try {
      await api.sendToChat(titleOf(ref), tracks);
      notify(
        playlist.tracks.length > MAX_SEND
          ? t("toast.sentFirst", { count: count(MAX_SEND, "unit.track") })
          : t("toast.sent", { count: count(tracks.length, "unit.track") }),
      );
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setBusy(null);
    }
  };

  const copyTrack = async (track: Track, ref: PlaylistRef) => {
    setSheet(null);
    const before = resolve(ref)?.tracks.length ?? 0;
    const result = await runOpOn(ref, { op: "addTracks", playlistId: ref.playlistId, tracks: [track] });
    const after = result?.find((playlist) => playlist.id === ref.playlistId);
    if (after) {
      const title = titleOf(ref) || after.title;
      notify(after.tracks.length > before ? t("toast.addedTo", { title }) : t("toast.alreadyIn", { title }));
    }
  };

  const deletePlaylist = async (ref: PlaylistRef) => {
    const playlist = resolve(ref);
    setSheet(null);
    if (!playlist || !(await confirmAction(t("confirm.delete", { title: titleOf(ref) })))) {
      return;
    }
    if (sameRef(player.state.source, ref)) {
      player.stop();
    }
    setView(null);
    await runOpOn(ref, { op: "deletePlaylist", playlistId: ref.playlistId });
  };

  /** Copies every track of one playlist into another, skipping ones already there. */
  const addAllTo = async (source: PlaylistRef, destination: PlaylistRef) => {
    setSheet(null);
    const tracks = resolve(source)?.tracks ?? [];
    const target = targetOf(destination);
    if (tracks.length === 0 || !target) {
      return;
    }
    const before = resolve(destination)?.tracks.length ?? 0;
    const batch = target.kind === "group" ? GROUP_BATCH : tracks.length;
    let result: Playlist[] | null = null;
    setBusy("copyAll");
    for (let start = 0; start < tracks.length; start += batch) {
      result = await runOp(target, {
        op: "addTracks",
        playlistId: destination.playlistId,
        tracks: tracks.slice(start, start + batch),
      });
      if (!result) {
        break;
      }
    }
    setBusy(null);
    const after = result?.find((playlist) => playlist.id === destination.playlistId);
    if (after) {
      const title = titleOf(destination) || after.title;
      const added = after.tracks.length - before;
      notify(
        added > 0
          ? t("toast.addedAll", { title, count: count(added, "unit.track") })
          : t("toast.allAlreadyIn", { title }),
      );
    }
  };

  /** Creates a new personal playlist with the tracks of all picked playlists, each file once. */
  const mergePlaylists = (refs: PlaylistRef[], title: string) => {
    setSheet(null);
    const current = libraryRef.current;
    if (!current) {
      return;
    }
    try {
      const playlists = applyPlaylistOp(current.playlists, { op: "createPlaylist", title });
      const created = playlists[playlists.length - 1];
      const seen = new Set<string>();
      const tracks: Track[] = [];
      for (const ref of refs) {
        for (const track of resolve(ref)?.tracks ?? []) {
          if (!seen.has(trackKey(track))) {
            seen.add(trackKey(track));
            // Keep the original "date added", so sorting by date still means something.
            tracks.push({ ...track, id: makeId() });
          }
        }
      }
      const merged = { ...created, tracks };
      playlists[playlists.length - 1] = merged;
      commitPersonal({ ...current, playlists });
      setView({ kind: "personal", playlistId: merged.id });
      notify(t("toast.merged", { title: merged.title, count: count(tracks.length, "unit.track") }));
    } catch (error) {
      notify(error instanceof PlaylistOpError ? error.message : errorText(error), true);
    }
  };

  const forgetGroup = (chatId: string) => {
    setSheet(null);
    setView(null);
    if (player.state.source?.kind === "group" && player.state.source.chatId === chatId) {
      player.stop();
    }
    if (libraryRef.current) {
      commitPersonal({
        ...libraryRef.current,
        groups: libraryRef.current.groups.filter((group) => group.chatId !== chatId),
        hiddenGroups: [...new Set([...libraryRef.current.hiddenGroups, chatId])],
      });
    }
  };

  // ---------- Render ----------

  if (fatal) {
    return (
      <main className="screen-message">
        <Icon name="music" size={36} />
        <h1>Tapehouse</h1>
        <p>{fatal}</p>
      </main>
    );
  }

  if (!library || !session) {
    return (
      <main className="screen-message">
        <div className="spinner" aria-label={t("app.loading")} />
      </main>
    );
  }

  const copyTargets: PlaylistChoice[] = [
    ...library.playlists.map((playlist) => ({
      ref: { kind: "personal", playlistId: playlist.id } as PlaylistRef,
      label: titleOf({ kind: "personal", playlistId: playlist.id }),
      trackCount: playlist.tracks.length,
    })),
    ...groupList.flatMap((group) =>
      group.status === "ready"
        ? group.playlists.map((playlist) => ({
            ref: { kind: "group", chatId: group.chatId, playlistId: playlist.id } as PlaylistRef,
            label: playlist.title,
            group: group.title,
            trackCount: playlist.tracks.length,
          }))
        : [],
    ),
  ];
  const isAll = (ref: PlaylistRef) => ref.kind === "all";
  const playingHere = !!view && sameRef(player.state.source, view) && player.state.playing;

  return (
    <div className={`app${view ? " app--detail" : ""}${player.state.track ? " app--with-player" : ""}`}>
      <aside className="pane pane--home">
        <Home
          userName={session.user.firstName}
          botUsername={session.botUsername}
          synced={isSyncedStorage}
          personal={library.playlists}
          inboxId={library.inboxId}
          groups={groupList}
          selected={view}
          nowPlaying={player.state.track ? player.state.source : null}
          onOpen={(ref) => {
            haptic.select();
            setView(ref);
          }}
          onCreate={(target, title) => void createPlaylist(target, title)}
          onOpenBot={() => openBotChat(session.botUsername)}
          onImport={(chatId) => setSheet({ type: "import", chatId })}
          allMusic={allMusic}
          onInfo={() => setSheet({ type: "info" })}
        />
      </aside>

      <main className="pane pane--detail">
        {view && current ? (
          <PlaylistScreen
            key={`${view.kind}:${view.playlistId}`}
            playlist={current}
            title={titleOf(view)}
            icon={isAll(view) ? "library" : isInbox(view) ? "inbox" : undefined}
            description={
              isAll(view)
                ? t("all.description")
                : isInbox(view) && DEFAULT_INBOX_DESCRIPTIONS.has(current.description)
                  ? t("inbox.description")
                  : current.description
            }
            readOnly={isAll(view)}
            emptyText={isAll(view) ? t("all.empty") : undefined}
            playingHere={playingHere}
            context={currentContext}
            currentTrackId={sameRef(player.state.source, view) ? player.state.track?.id ?? null : null}
            isPlaying={player.state.playing}
            busy={busy}
            onBack={() => setView(null)}
            onPlay={(track) => {
              if (player.state.track?.id === track.id && sameRef(player.state.source, view)) {
                player.toggle();
              } else {
                player.play(view, track);
              }
            }}
            onPlayAll={() => {
              // While this playlist plays the button reads "Stop"; after stopping it continues from there.
              if (sameRef(player.state.source, view) && player.state.track) {
                player.toggle();
                return;
              }
              const first = player.firstTrack(current);
              if (first) {
                player.play(view, first);
              }
            }}
            onShuffle={() => void shuffle()}
            onReorder={(trackIds) => {
              haptic.tap();
              void runOpOn(view, { op: "reorder", playlistId: view.playlistId, trackIds });
            }}
            onSend={() => void sendToChat(view)}
            onTrackMore={(track) => setSheet({ type: "track", ref: view, track })}
            onPlaylistMore={() => setSheet({ type: "playlist", ref: view })}
          />
        ) : (
          <div className="empty-detail">
            <Icon name="music" size={40} />
            <p>{t("playlist.pick")}</p>
          </div>
        )}
      </main>

      <PlayerBar
        state={player.state}
        onToggle={player.toggle}
        onNext={player.next}
        onPrevious={player.previous}
        onSeek={player.seek}
        onShuffle={() => {
          haptic.select();
          player.toggleShuffle();
        }}
      />

      {sheet?.type === "track" ? (
        <Sheet title={sheet.track.title} subtitle={sheet.track.performer} onClose={() => setSheet(null)}>
          <SheetButton icon={<Icon name="copy" />} onClick={() => setSheet({ ...sheet, type: "copy" })}>
            {t("sheet.addToPlaylist")}
          </SheetButton>
          <SheetButton
            icon={<Icon name="send" />}
            onClick={() => {
              setSheet(null);
              setBusy("send");
              api
                .sendToChat("", [sheet.track])
                .then(() => notify(t("toast.sentOne")))
                .catch((error) => notify(errorText(error), true))
                .finally(() => setBusy(null));
            }}
          >
            {t("sheet.sendToChat")}
          </SheetButton>
          {isAll(sheet.ref) ? null : (
            <SheetButton
              icon={<Icon name="trash" />}
              danger
              onClick={() => {
                setSheet(null);
                void runOpOn(sheet.ref, {
                  op: "removeTrack",
                  playlistId: sheet.ref.playlistId,
                  trackId: sheet.track.id,
                });
              }}
            >
              {t("sheet.removeFromPlaylist")}
            </SheetButton>
          )}
        </Sheet>
      ) : null}

      {sheet?.type === "copy" ? (
        <Sheet title={t("sheet.addTitle")} subtitle={sheet.track.title} onClose={() => setSheet(null)}>
          {copyTargets.filter((target) => !sameRef(target.ref, sheet.ref)).length === 0 ? (
            <p className="muted">{t("sheet.createFirst")}</p>
          ) : (
            copyTargets
              .filter((target) => !sameRef(target.ref, sheet.ref))
              .map((target) => (
                <SheetButton
                  key={`${target.ref.kind}:${target.ref.playlistId}`}
                  icon={<Icon name={target.group ? "users" : "music"} />}
                  onClick={() => void copyTrack(sheet.track, target.ref)}
                >
                  {target.label}
                  {target.group ? <small> · {target.group}</small> : null}
                </SheetButton>
              ))
          )}
        </Sheet>
      ) : null}

      {sheet?.type === "playlist" ? (
        <Sheet title={titleOf(sheet.ref)} onClose={() => setSheet(null)}>
          {isAll(sheet.ref) ? null : (
            <SheetButton icon={<Icon name="edit" />} onClick={() => setSheet({ type: "rename", ref: sheet.ref })}>
              {t("sheet.rename")}
            </SheetButton>
          )}
          <SheetButton
            icon={<Icon name="send" />}
            onClick={() => {
              setSheet(null);
              void sendToChat(sheet.ref);
            }}
          >
            {t("sheet.sendAll")}
          </SheetButton>
          <SheetButton
            icon={<Icon name="copy" />}
            disabled={(resolve(sheet.ref)?.tracks.length ?? 0) === 0 || busy === "copyAll"}
            onClick={() => setSheet({ type: "copyAll", ref: sheet.ref })}
          >
            {t("sheet.addAllTo")}
          </SheetButton>
          {isAll(sheet.ref) ? null : (
            <SheetButton icon={<Icon name="merge" />} onClick={() => setSheet({ type: "merge", ref: sheet.ref })}>
              {t("sheet.merge")}
            </SheetButton>
          )}
          {isAll(sheet.ref) ? null : (["newest", "oldest"] as const).map((order) => (
            <SheetButton
              key={order}
              icon={<Icon name="sort" />}
              onClick={() => {
                setSheet(null);
                void runOpOn(sheet.ref, { op: "sortByAdded", playlistId: sheet.ref.playlistId, order }).then((result) => {
                  if (result) {
                    haptic.success();
                    notify(t("toast.sorted"));
                  }
                });
              }}
            >
              {t(order === "newest" ? "sheet.sortNewest" : "sheet.sortOldest")}
            </SheetButton>
          ))}
          {sheet.ref.kind === "group" ? (
            <SheetButton
              icon={<Icon name="inbox" />}
              onClick={() => setSheet({ type: "import", chatId: (sheet.ref as { chatId: string }).chatId })}
            >
              {t("sheet.importHistory")}
            </SheetButton>
          ) : null}
          {sheet.ref.kind === "group" ? (
            <SheetButton icon={<Icon name="close" />} onClick={() => forgetGroup((sheet.ref as { chatId: string }).chatId)}>
              {t("sheet.hideGroup")}
            </SheetButton>
          ) : null}
          {isAll(sheet.ref) ? null : (
            <SheetButton icon={<Icon name="trash" />} danger onClick={() => void deletePlaylist(sheet.ref)}>
              {t("sheet.deletePlaylist")}
            </SheetButton>
          )}
        </Sheet>
      ) : null}

      {sheet?.type === "copyAll" ? (
        <Sheet title={t("sheet.addAllTitle")} subtitle={titleOf(sheet.ref)} onClose={() => setSheet(null)}>
          {copyTargets.filter((target) => !sameRef(target.ref, sheet.ref)).length === 0 ? (
            <p className="muted">{t("sheet.createFirst")}</p>
          ) : (
            copyTargets
              .filter((target) => !sameRef(target.ref, sheet.ref))
              .map((target) => (
                <SheetButton
                  key={`${target.ref.kind}:${target.ref.playlistId}`}
                  icon={<Icon name={target.group ? "users" : "music"} />}
                  onClick={() => void addAllTo(sheet.ref, target.ref)}
                >
                  {target.label}
                  {target.group ? <small> · {target.group}</small> : null}
                </SheetButton>
              ))
          )}
        </Sheet>
      ) : null}

      {sheet?.type === "merge" ? (
        <MergeSheet
          choices={copyTargets}
          initial={sheet.ref}
          onClose={() => setSheet(null)}
          onMerge={mergePlaylists}
        />
      ) : null}

      {sheet?.type === "info" ? <InfoSheet botUsername={session.botUsername} onClose={() => setSheet(null)} /> : null}

      {sheet?.type === "rename" ? (
        <RenameSheet
          playlist={resolve(sheet.ref)}
          title={titleOf(sheet.ref)}
          onClose={() => setSheet(null)}
          onSave={(title, description, emoji) => {
            setSheet(null);
            void runOpOn(sheet.ref, {
              op: "updatePlaylist",
              playlistId: sheet.ref.playlistId,
              title,
              description,
              emoji,
            });
          }}
        />
      ) : null}

      {sheet?.type === "import" ? (
        <ImportSheet
          chatId={sheet.chatId}
          chatTitle={groups[sheet.chatId]?.title ?? ""}
          onClose={() => setSheet(null)}
          onProgress={() => void refreshGroup(sheet.chatId)}
          onDone={() => {
            // Jump to the playlist the import filled.
            const chatId = sheet.chatId;
            void api.getGroup(chatId).then((data) => {
              applyGroup(data);
              const main = data.playlists.find((playlist) => playlist.id === data.mainPlaylistId);
              if (main) {
                setView({ kind: "group", chatId, playlistId: main.id });
              }
            });
          }}
        />
      ) : null}

      {toast ? (
        <div className={`toast${toast.error ? " toast--error" : ""}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

const EMOJI_CHOICES = [
  "🎵", "🎧", "🎸", "🎹", "🥁", "🎤", "🎷", "💿",
  "🔥", "❤️", "✨", "🌙", "☀️", "🌊", "🌃", "🍂",
  "❄️", "🚗", "🏃", "💤", "🧘", "🎉", "☕", "🗽",
];

function RenameSheet({
  playlist,
  title: currentTitle,
  onClose,
  onSave,
}: {
  playlist?: Playlist;
  title: string;
  onClose: () => void;
  onSave: (title: string, description: string, emoji: string) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(currentTitle);
  const [description, setDescription] = useState(playlist?.description ?? "");
  const [emoji, setEmoji] = useState(playlist?.emoji ?? "");
  const [custom, setCustom] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(title, description, emoji);
  };

  return (
    <Sheet title={t("sheet.editTitle")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span>{t("sheet.cover")}</span>
          <div className="emoji-editor">
            <Cover playlist={{ accent: playlist?.accent ?? "#888", emoji: emoji || undefined }} title={title} large />
            <div className="emoji-grid" role="radiogroup" aria-label={t("sheet.cover")}>
              <button
                type="button"
                role="radio"
                aria-checked={!emoji}
                className={`emoji-choice emoji-choice--none${!emoji ? " emoji-choice--active" : ""}`}
                onClick={() => setEmoji("")}
                title={t("sheet.noEmoji")}
              >
                Aa
              </button>
              {EMOJI_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={emoji === choice}
                  className={`emoji-choice${emoji === choice ? " emoji-choice--active" : ""}`}
                  onClick={() => setEmoji(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
          <input
            className="input"
            value={custom}
            placeholder={t("sheet.customEmoji")}
            maxLength={16}
            onChange={(e) => {
              setCustom(e.target.value);
              const picked = normalizeEmoji(e.target.value);
              if (picked) {
                setEmoji(picked);
              }
            }}
          />
        </div>
        <label className="field">
          <span>{t("sheet.name")}</span>
          <input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("sheet.description")}</span>
          <textarea
            className="input"
            rows={2}
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button className="button button--primary" type="submit" disabled={!title.trim()}>
          {t("sheet.save")}
        </button>
      </form>
    </Sheet>
  );
}
