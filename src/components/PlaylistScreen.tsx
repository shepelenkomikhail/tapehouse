import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useState } from "react";
import type { Playlist, Track } from "../../shared/types";
import { formatRuntime, plural } from "../lib/format";
import { Icon } from "./Icon";
import { TrackRow } from "./TrackRow";

interface PlaylistScreenProps {
  playlist: Playlist;
  context: string;
  currentTrackId: string | null;
  isPlaying: boolean;
  busy: string | null;
  onBack: () => void;
  onPlay: (track: Track) => void;
  onShuffle: () => void;
  onReorder: (trackIds: string[]) => void;
  onSend: () => void;
  onTrackMore: (track: Track) => void;
  onPlaylistMore: () => void;
}

export function PlaylistScreen(props: PlaylistScreenProps) {
  const { playlist } = props;
  const [filter, setFilter] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const query = filter.trim().toLowerCase();
  const visible = query
    ? playlist.tracks.filter(
        (track) => track.title.toLowerCase().includes(query) || track.performer.toLowerCase().includes(query),
      )
    : playlist.tracks;
  const seconds = playlist.tracks.reduce((sum, track) => sum + track.durationSec, 0);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }
    const ids = playlist.tracks.map((track) => track.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) {
      props.onReorder(arrayMove(ids, from, to));
    }
  };

  return (
    <div className="playlist">
      <header className="playlist__header">
        <button className="icon-button back-button" type="button" aria-label="Back" onClick={props.onBack}>
          <Icon name="back" />
        </button>
        <span className="cover cover--large" style={{ background: playlist.accent }} aria-hidden="true">
          {playlist.title.slice(0, 1).toUpperCase()}
        </span>
        <div className="playlist__meta">
          <span className="eyebrow">{props.context}</span>
          <h2>{playlist.title}</h2>
          {playlist.description ? <p>{playlist.description}</p> : null}
          <p className="muted">
            {plural(playlist.tracks.length, "track")}
            {seconds > 0 ? ` · ${formatRuntime(seconds)}` : ""}
          </p>
        </div>
        <button className="icon-button" type="button" aria-label="Playlist options" onClick={props.onPlaylistMore}>
          <Icon name="more" />
        </button>
      </header>

      <div className="toolbar">
        <button
          className="button button--primary"
          type="button"
          disabled={playlist.tracks.length === 0}
          onClick={() => playlist.tracks[0] && props.onPlay(playlist.tracks[0])}
        >
          <Icon name="play" size={16} /> Play
        </button>
        <button
          className="button"
          type="button"
          disabled={playlist.tracks.length < 2 || props.busy === "shuffle"}
          onClick={props.onShuffle}
          title="Reorders the playlist, keeping the same artist from playing twice in a row"
        >
          <Icon name="shuffle" size={16} /> Shuffle
        </button>
        <button
          className="button"
          type="button"
          disabled={playlist.tracks.length === 0 || props.busy === "send"}
          onClick={props.onSend}
          title="The bot sends these tracks to your chat, for Telegram's own player"
        >
          <Icon name="send" size={16} /> {props.busy === "send" ? "Sending…" : "Send to chat"}
        </button>
      </div>

      {playlist.tracks.length > 6 ? (
        <input
          className="input search"
          type="search"
          placeholder="Search in playlist"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      ) : null}

      {playlist.tracks.length === 0 ? (
        <div className="hint">
          <Icon name="music" size={28} />
          <p>No tracks yet. Use “Add to playlist” on any track in your Inbox, or send audio to the bot.</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={visible.map((track) => track.id)} strategy={verticalListSortingStrategy}>
            <ol className="tracks">
              {visible.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={playlist.tracks.indexOf(track)}
                  isCurrent={track.id === props.currentTrackId}
                  isPlaying={props.isPlaying}
                  canReorder={!query}
                  onPlay={() => props.onPlay(track)}
                  onMore={() => props.onTrackMore(track)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
