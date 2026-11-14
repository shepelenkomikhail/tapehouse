import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { applyPlaylistOp, PlaylistOpError } from "../shared/playlist-ops";
import type { GroupLibrary, Playlist, PlaylistOp, SessionUser, Track } from "../shared/types";
import { Home, type GroupView } from "./components/Home";
import { Icon } from "./components/Icon";
import { PlayerBar } from "./components/PlayerBar";
import { PlaylistScreen } from "./components/PlaylistScreen";
import { Sheet, SheetButton } from "./components/Sheet";
import { sameRef, usePlayer, type PlaylistRef } from "./hooks/usePlayer";
import { api, ApiError } from "./lib/api";
import { isSyncedStorage } from "./lib/cloud-storage";
import { loadLibrary, mergeInbox, persistLibrary, type PersonalLibrary } from "./lib/library";
import { confirmAction, getStartParam, getWebApp, haptic, initTelegram, openBotChat } from "./lib/telegram";

type Target = { kind: "personal" } | { kind: "group"; chatId: string };
type SheetState =
  | { type: "track"; ref: PlaylistRef; track: Track }
  | { type: "copy"; ref: PlaylistRef; track: Track }
  | { type: "playlist"; ref: PlaylistRef }
  | { type: "rename"; ref: PlaylistRef };

const MAX_SEND = 100;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function App() {
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

  const resolve = useCallback(
    (ref: PlaylistRef): Playlist | undefined => {
      if (ref.kind === "personal") {
        return library?.playlists.find((playlist) => playlist.id === ref.playlistId);
      }
      return groups[ref.chatId]?.playlists.find((playlist) => playlist.id === ref.playlistId);
    },
    [library, groups],
  );

  const player = usePlayer(resolve);

  /** Replace the personal library and persist the difference to Telegram CloudStorage. */
  const commitPersonal = useCallback(
    (next: PersonalLibrary) => {
      const previous = libraryRef.current;
      libraryRef.current = next;
      setLibrary(next);
      if (previous) {
        persistLibrary(previous, next).catch(() =>
          notify("Couldn't save to your Telegram cloud. Check your connection.", true),
        );
      }
    },
    [notify],
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
    [applyGroup, setGroup],
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
      if (group && (op.op === "reorder" || op.op === "removeTrack" || op.op === "updatePlaylist")) {
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
    [applyGroup, commitPersonal, loadGroup, notify, setGroup],
  );

  const targetOf = (ref: PlaylistRef): Target =>
    ref.kind === "personal" ? { kind: "personal" } : { kind: "group", chatId: ref.chatId };

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
        setFatal(`Couldn't load your playlists from Telegram. ${errorText(error)}`);
        return;
      }
      libraryRef.current = lib;
      setLibrary(lib);

      let inbox: Track[] = [];
      try {
        const response = await api.getInbox();
        setSession({ user: response.user, botUsername: response.botUsername });
        inbox = response.inbox;
      } catch (error) {
        setFatal(
          error instanceof ApiError && error.status === 401
            ? "Open Tapehouse from your Telegram bot to use it."
            : `Couldn't reach Tapehouse. ${errorText(error)}`,
        );
        return;
      }

      if (inbox.length > 0) {
        const merged = mergeInbox(libraryRef.current!, inbox);
        const previous = libraryRef.current!;
        libraryRef.current = merged.library;
        setLibrary(merged.library);
        try {
          // Only clear the server inbox once the tracks are safely in CloudStorage.
          await persistLibrary(previous, merged.library);
          await api.ackInbox(inbox.map((track) => track.id));
          if (merged.added > 0) {
            notify(`${merged.added} new ${merged.added === 1 ? "track" : "tracks"} in your Inbox`);
          }
        } catch {
          notify("New tracks arrived but couldn't be saved yet. They'll retry next time.", true);
        }
      }

      const known = libraryRef.current?.groups ?? [];
      const startParam = getStartParam();
      const startGroup = startParam?.match(/^g(-?\d+)$/)?.[1];

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
          if (data.playlists[0]) {
            setView({ kind: "group", chatId: startGroup, playlistId: data.playlists[0].id });
          }
        }
      }
    })();
  }, [commitPersonal, loadGroup, notify]);

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
      notify(player.state.error, true);
      player.clearError();
    }
  }, [player, notify]);

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
  const currentContext =
    view?.kind === "group" ? groups[view.chatId]?.title ?? "Group" : view?.playlistId === library?.inboxId ? "Inbox" : "My playlist";

  // If the open playlist disappears (deleted elsewhere), fall back to home.
  useEffect(() => {
    if (view && library && !resolve(view) && (view.kind === "personal" || groups[view.chatId]?.status === "ready")) {
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
    setBusy("shuffle");
    await runOp(targetOf(view), { op: "shuffle", playlistId: view.playlistId });
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
      await api.sendToChat(playlist.title, tracks);
      notify(
        playlist.tracks.length > MAX_SEND
          ? `Sent the first ${MAX_SEND} tracks to your chat with the bot`
          : `Sent ${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} to your chat with the bot`,
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
    const result = await runOp(targetOf(ref), { op: "addTracks", playlistId: ref.playlistId, tracks: [track] });
    const after = result?.find((playlist) => playlist.id === ref.playlistId);
    if (after) {
      notify(after.tracks.length > before ? `Added to “${after.title}”` : `Already in “${after.title}”`);
    }
  };

  const deletePlaylist = async (ref: PlaylistRef) => {
    const playlist = resolve(ref);
    setSheet(null);
    if (!playlist || !(await confirmAction(`Delete “${playlist.title}”? This can't be undone.`))) {
      return;
    }
    if (sameRef(player.state.source, ref)) {
      player.stop();
    }
    setView(null);
    await runOp(targetOf(ref), { op: "deletePlaylist", playlistId: ref.playlistId });
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
        <div className="spinner" aria-label="Loading" />
      </main>
    );
  }

  const copyTargets: { ref: PlaylistRef; label: string; group?: string }[] = [
    ...library.playlists.map((playlist) => ({
      ref: { kind: "personal", playlistId: playlist.id } as PlaylistRef,
      label: playlist.title,
    })),
    ...groupList.flatMap((group) =>
      group.status === "ready"
        ? group.playlists.map((playlist) => ({
            ref: { kind: "group", chatId: group.chatId, playlistId: playlist.id } as PlaylistRef,
            label: playlist.title,
            group: group.title,
          }))
        : [],
    ),
  ];

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
        />
      </aside>

      <main className="pane pane--detail">
        {view && current ? (
          <PlaylistScreen
            key={`${view.kind}:${view.playlistId}`}
            playlist={current}
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
            onShuffle={() => void shuffle()}
            onReorder={(trackIds) => {
              haptic.tap();
              void runOp(targetOf(view), { op: "reorder", playlistId: view.playlistId, trackIds });
            }}
            onSend={() => void sendToChat(view)}
            onTrackMore={(track) => setSheet({ type: "track", ref: view, track })}
            onPlaylistMore={() => setSheet({ type: "playlist", ref: view })}
          />
        ) : (
          <div className="empty-detail">
            <Icon name="music" size={40} />
            <p>Pick a playlist to see its tracks.</p>
          </div>
        )}
      </main>

      <PlayerBar
        state={player.state}
        onToggle={player.toggle}
        onNext={player.next}
        onPrevious={player.previous}
        onSeek={player.seek}
      />

      {sheet?.type === "track" ? (
        <Sheet title={sheet.track.title} subtitle={sheet.track.performer} onClose={() => setSheet(null)}>
          <SheetButton icon={<Icon name="copy" />} onClick={() => setSheet({ ...sheet, type: "copy" })}>
            Add to playlist…
          </SheetButton>
          <SheetButton
            icon={<Icon name="send" />}
            onClick={() => {
              setSheet(null);
              setBusy("send");
              api
                .sendToChat("", [sheet.track])
                .then(() => notify("Sent to your chat with the bot"))
                .catch((error) => notify(errorText(error), true))
                .finally(() => setBusy(null));
            }}
          >
            Send to chat
          </SheetButton>
          <SheetButton
            icon={<Icon name="trash" />}
            danger
            onClick={() => {
              setSheet(null);
              void runOp(targetOf(sheet.ref), {
                op: "removeTrack",
                playlistId: sheet.ref.playlistId,
                trackId: sheet.track.id,
              });
            }}
          >
            Remove from this playlist
          </SheetButton>
        </Sheet>
      ) : null}

      {sheet?.type === "copy" ? (
        <Sheet title="Add to playlist" subtitle={sheet.track.title} onClose={() => setSheet(null)}>
          {copyTargets.filter((target) => !sameRef(target.ref, sheet.ref)).length === 0 ? (
            <p className="muted">Create another playlist first.</p>
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
        <Sheet title={resolve(sheet.ref)?.title ?? "Playlist"} onClose={() => setSheet(null)}>
          <SheetButton icon={<Icon name="edit" />} onClick={() => setSheet({ type: "rename", ref: sheet.ref })}>
            Rename
          </SheetButton>
          <SheetButton
            icon={<Icon name="send" />}
            onClick={() => {
              setSheet(null);
              void sendToChat(sheet.ref);
            }}
          >
            Send all to chat
          </SheetButton>
          {sheet.ref.kind === "group" ? (
            <SheetButton icon={<Icon name="close" />} onClick={() => forgetGroup((sheet.ref as { chatId: string }).chatId)}>
              Hide this group from my list
            </SheetButton>
          ) : null}
          <SheetButton icon={<Icon name="trash" />} danger onClick={() => void deletePlaylist(sheet.ref)}>
            Delete playlist
          </SheetButton>
        </Sheet>
      ) : null}

      {sheet?.type === "rename" ? (
        <RenameSheet
          playlist={resolve(sheet.ref)}
          onClose={() => setSheet(null)}
          onSave={(title, description) => {
            setSheet(null);
            void runOp(targetOf(sheet.ref), {
              op: "updatePlaylist",
              playlistId: sheet.ref.playlistId,
              title,
              description,
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

function RenameSheet({
  playlist,
  onClose,
  onSave,
}: {
  playlist?: Playlist;
  onClose: () => void;
  onSave: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState(playlist?.title ?? "");
  const [description, setDescription] = useState(playlist?.description ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(title, description);
  };

  return (
    <Sheet title="Edit playlist" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            className="input"
            rows={2}
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button className="button button--primary" type="submit" disabled={!title.trim()}>
          Save
        </button>
      </form>
    </Sheet>
  );
}
