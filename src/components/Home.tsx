import { useState, type FormEvent } from "react";
import type { Playlist } from "../../shared/types";
import { sameRef, type PlaylistRef } from "../hooks/usePlayer";
import { formatRuntime, plural } from "../lib/format";
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
}

function runtime(playlist: Playlist) {
  return playlist.tracks.reduce((sum, track) => sum + track.durationSec, 0);
}

function PlaylistItem({
  playlist,
  icon,
  active,
  playing,
  onClick,
}: {
  playlist: Playlist;
  icon?: "inbox";
  active: boolean;
  playing: boolean;
  onClick: () => void;
}) {
  const seconds = runtime(playlist);
  return (
    <li>
      <button className={`list-item${active ? " list-item--active" : ""}`} type="button" onClick={onClick}>
        <span className="cover" style={{ background: playlist.accent }} aria-hidden="true">
          {icon ? <Icon name={icon} size={20} /> : playlist.title.slice(0, 1).toUpperCase()}
        </span>
        <span className="list-item__text">
          <strong>{playlist.title}</strong>
          <span>
            {plural(playlist.tracks.length, "track")}
            {seconds > 0 ? ` · ${formatRuntime(seconds)}` : ""}
          </span>
        </span>
        {playing ? <span className="eq eq--small" aria-label="Now playing"><i /><i /><i /></span> : null}
      </button>
    </li>
  );
}

function NewPlaylistForm({ onCreate }: { onCreate: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  if (!open) {
    return (
      <button className="add-button" type="button" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} /> New playlist
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
        placeholder="Playlist name"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => !title.trim() && setOpen(false)}
      />
      <button className="button button--primary" type="submit" disabled={!title.trim()}>
        Create
      </button>
    </form>
  );
}

export function Home(props: HomeProps) {
  const { personal, inboxId, groups, selected, nowPlaying, onOpen, onCreate } = props;
  const ordered = [
    ...personal.filter((playlist) => playlist.id === inboxId),
    ...personal.filter((playlist) => playlist.id !== inboxId),
  ];
  const handle = props.botUsername ? `@${props.botUsername}` : "the bot";

  return (
    <div className="home">
      <header className="home__header">
        <div>
          <h1>Tapehouse</h1>
          <p>
            Hi, {props.userName}
            {props.synced ? "" : " · preview mode, saved in this browser only"}
          </p>
        </div>
        <button className="button" type="button" onClick={props.onOpenBot} disabled={!props.botUsername}>
          <Icon name="send" size={16} /> Add music
        </button>
      </header>

      <section className="section">
        <h2 className="section__title">My playlists</h2>
        {ordered.length === 0 ? (
          <div className="hint">
            <Icon name="music" size={28} />
            <p>
              Forward or send audio files to <strong>{handle}</strong>. They land in your Inbox here, ready to sort
              into playlists. Everything is stored in your Telegram account.
            </p>
          </div>
        ) : (
          <ul className="list">
            {ordered.map((playlist) => {
              const ref: PlaylistRef = { kind: "personal", playlistId: playlist.id };
              return (
                <PlaylistItem
                  key={playlist.id}
                  playlist={playlist}
                  icon={playlist.id === inboxId ? "inbox" : undefined}
                  active={sameRef(selected, ref)}
                  playing={sameRef(nowPlaying, ref)}
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
          {group.status === "loading" ? <p className="muted">Loading…</p> : null}
          {group.status === "error" ? <p className="muted">{group.error}</p> : null}
          {group.status === "ready" ? (
            <>
              {group.playlists.length === 0 ? (
                <p className="muted">
                  No shared playlists yet. In the group, reply /save@{props.botUsername ?? "bot"} to a track.
                </p>
              ) : (
                <ul className="list">
                  {group.playlists.map((playlist) => {
                    const ref: PlaylistRef = { kind: "group", chatId: group.chatId, playlistId: playlist.id };
                    return (
                      <PlaylistItem
                        key={playlist.id}
                        playlist={playlist}
                        active={sameRef(selected, ref)}
                        playing={sameRef(nowPlaying, ref)}
                        onClick={() => onOpen(ref)}
                      />
                    );
                  })}
                </ul>
              )}
              <NewPlaylistForm onCreate={(title) => onCreate({ kind: "group", chatId: group.chatId }, title)} />
            </>
          ) : null}
        </section>
      ))}

      {groups.length === 0 ? (
        <section className="section">
          <h2 className="section__title">Groups</h2>
          <p className="muted">
            Add {handle} to a group chat to build shared playlists together. Open them from the button the bot
            posts in the group.
          </p>
        </section>
      ) : null}
    </div>
  );
}
