import { useState, type FormEvent } from "react";
import type { Playlist } from "../../shared/types";
import { ALL_REF, sameRef, type PlaylistRef } from "../hooks/usePlayer";
import { DEFAULT_INBOX_TITLES, LANGS, useI18n } from "../lib/i18n";
import { Cover } from "./Cover";
import { Icon } from "./Icon";

export interface GroupView {
  chatId: string;
  title: string;
  playlists: Playlist[];
  status: "loading" | "ready" | "error";
  error?: string;
}

interface HomeProps {
  userName: string;
  botUsername?: string;
  synced: boolean;
  personal: Playlist[];
  inboxId: string | null;
  groups: GroupView[];
  selected: PlaylistRef | null;
  nowPlaying: PlaylistRef | null;
  onOpen: (ref: PlaylistRef) => void;
  onCreate: (target: { kind: "personal" } | { kind: "group"; chatId: string }, title: string) => void;
  onOpenBot: () => void;
  onImport: (chatId: string) => void;
  /** "All music": every track from every playlist, each once. */
  allMusic: Playlist;
  /** Personal playlists whose tracks are still loading. */
  loadingIds: ReadonlySet<string>;
  onInfo: () => void;
  onFind: () => void;
}

function PlaylistItem({
  playlist,
  title,
  icon,
  active,
  playing,
  loading = false,
  onClick,
}: {
  playlist: Playlist;
  title: string;
  icon?: "inbox" | "library";
  active: boolean;
  playing: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  const { t, count, runtime } = useI18n();
  const seconds = playlist.tracks.reduce((sum, track) => sum + track.durationSec, 0);
  return (
    <li>
      <button className={`list-item${active ? " list-item--active" : ""}`} type="button" onClick={onClick}>
        <Cover playlist={playlist} title={title} fallbackIcon={icon} />
        <span className="list-item__text">
          <strong>{title}</strong>
          <span>
            {loading && playlist.tracks.length === 0
              ? t("home.loading")
              : `${count(playlist.tracks.length, "unit.track")}${loading ? "…" : seconds > 0 ? ` · ${runtime(seconds)}` : ""}`}
          </span>
        </span>
        {playing ? (
          <span className="eq eq--small" aria-label={t("home.nowPlaying")}>
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </button>
    </li>
  );
}

function NewPlaylistForm({ onCreate }: { onCreate: (title: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  if (!open) {
    return (
      <button className="add-button" type="button" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} /> {t("home.newPlaylist")}
      </button>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) {
      onCreate(title.trim());
    }
    setTitle("");
    setOpen(false);
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        autoFocus
        className="input"
        value={title}
        maxLength={80}
        placeholder={t("home.playlistName")}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => !title.trim() && setOpen(false)}
      />
      <button className="button button--primary" type="submit" disabled={!title.trim()}>
        {t("home.create")}
      </button>
    </form>
  );
}

function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t("home.language")}>
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          className={`lang-switch__option${code === lang ? " lang-switch__option--active" : ""}`}
          aria-pressed={code === lang}
          onClick={() => setLang(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Home(props: HomeProps) {
  const { t } = useI18n();
  const { personal, inboxId, groups, selected, nowPlaying, onOpen, onCreate } = props;
  const [showHowTo, setShowHowTo] = useState(false);
  const ordered = [
    ...personal.filter((playlist) => playlist.id === inboxId),
    ...personal.filter((playlist) => playlist.id !== inboxId),
  ];
  const botName = props.botUsername ?? "bot";
  const handle = props.botUsername ? `@${props.botUsername}` : "bot";
  const sharedHint = t("home.sharedHint", { bot: handle, botName });

  return (
    <div className="home">
      <header className="home__header">
        <div className="home__top">
          <h1>Tapehouse</h1>
          <button
            className="icon-button info-button"
            type="button"
            aria-label={t("home.info")}
            title={t("home.info")}
            onClick={props.onInfo}
          >
            <Icon name="info" size={22} />
          </button>
        </div>
        <div className="home__greeting">
          <p>
            {t("home.greeting", { name: props.userName })}
            {props.synced ? "" : t("home.previewMode")}
          </p>
          <LanguageSwitch />
        </div>
        <div className="home__actions">
          <button
            className="button button--primary"
            type="button"
            onClick={props.onOpenBot}
            disabled={!props.botUsername}
          >
            <Icon name="send" size={16} /> {t("home.addMusic")}
          </button>
          <button className="button" type="button" onClick={props.onFind}>
            <Icon name="search" size={16} /> {t("find.open")}
          </button>
        </div>
      </header>

      <section className="section">
        <h2 className="section__title">{t("home.myPlaylists")}</h2>
        {props.allMusic.tracks.length > 0 ? (
          <ul className="list">
            <PlaylistItem
              playlist={props.allMusic}
              title={t("all.title")}
              icon="library"
              active={sameRef(selected, ALL_REF)}
              playing={sameRef(nowPlaying, ALL_REF)}
              loading={props.loadingIds.size > 0}
              onClick={() => onOpen(ALL_REF)}
            />
          </ul>
        ) : null}
        {ordered.length === 0 ? (
          <div className="hint">
            <Icon name="music" size={28} />
            <p>{t("home.emptyHint", { bot: handle })}</p>
          </div>
        ) : (
          <ul className="list">
            {ordered.map((playlist) => {
              const ref: PlaylistRef = { kind: "personal", playlistId: playlist.id };
              const isInbox = playlist.id === inboxId;
              return (
                <PlaylistItem
                  key={playlist.id}
                  playlist={playlist}
                  title={isInbox && DEFAULT_INBOX_TITLES.has(playlist.title) ? t("inbox.title") : playlist.title}
                  icon={isInbox ? "inbox" : undefined}
                  active={sameRef(selected, ref)}
                  playing={sameRef(nowPlaying, ref)}
                  loading={props.loadingIds.has(playlist.id)}
                  onClick={() => onOpen(ref)}
                />
              );
            })}
          </ul>
        )}
        <NewPlaylistForm onCreate={(title) => onCreate({ kind: "personal" }, title)} />
      </section>

      {groups.map((group) => (
        <section className="section" key={group.chatId}>
          <h2 className="section__title">
            <Icon name="users" size={16} /> {group.title}
          </h2>
          {group.status === "loading" ? <p className="muted">{t("home.loading")}</p> : null}
          {group.status === "error" ? <p className="muted">{group.error}</p> : null}
          {group.status === "ready" ? (
            <>
              {group.playlists.length === 0 ? (
                <p className="muted">{t("home.groupEmpty", { botName })}</p>
              ) : (
                <ul className="list">
                  {group.playlists.map((playlist) => {
                    const ref: PlaylistRef = { kind: "group", chatId: group.chatId, playlistId: playlist.id };
                    return (
                      <PlaylistItem
                        key={playlist.id}
                        playlist={playlist}
                        title={playlist.title}
                        active={sameRef(selected, ref)}
                        playing={sameRef(nowPlaying, ref)}
                        onClick={() => onOpen(ref)}
                      />
                    );
                  })}
                </ul>
              )}
              <button className="add-button" type="button" onClick={() => props.onImport(group.chatId)}>
                <Icon name="inbox" size={18} /> {t("home.importChat")}
              </button>
              <NewPlaylistForm onCreate={(title) => onCreate({ kind: "group", chatId: group.chatId }, title)} />
            </>
          ) : null}
        </section>
      ))}

      <section className="section">
        {groups.length === 0 ? (
          <>
            <h2 className="section__title">{t("home.sharedTitle")}</h2>
            <p className="muted muted--pre">{sharedHint}</p>
          </>
        ) : (
          <>
            <button className="add-button" type="button" onClick={() => setShowHowTo((value) => !value)}>
              <Icon name="users" size={18} /> {t("home.howToAdd")}
            </button>
            {showHowTo ? <p className="muted muted--pre">{sharedHint}</p> : null}
          </>
        )}
      </section>
    </div>
  );
}
