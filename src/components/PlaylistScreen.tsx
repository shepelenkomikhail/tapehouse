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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Playlist, Track } from "../../shared/types";
import { useI18n } from "../lib/i18n";
import { Cover } from "./Cover";
import { Icon } from "./Icon";
import { TrackRow } from "./TrackRow";

interface PlaylistScreenProps {
  playlist: Playlist;
  title: string;
  description: string;
  icon?: "inbox" | "library";
  context: string;
  currentTrackId: string | null;
  isPlaying: boolean;
  /** Music from this playlist is playing right now: the main button turns into "Stop". */
  playingHere: boolean;
  /** Built automatically ("All music"): no reordering, and "Shuffle" only changes the play order. */
  readOnly?: boolean;
  /** Tracks are still arriving: the ones already here can be played, the rest show up as they load. */
  loading?: boolean;
  emptyText?: string;
  busy: string | null;
  onBack: () => void;
  onPlay: (track: Track) => void;
  onPlayAll: () => void;
  onShuffle: () => void;
  onReorder: (trackIds: string[]) => void;
  onSend: () => void;
  onTrackMore: (track: Track) => void;
  onPlaylistMore: () => void;
}

/** Rows rendered at first; more are added as you scroll, so big playlists open instantly. */
const FIRST_ROWS = 60;
const MORE_ROWS = 200;

export function PlaylistScreen(props: PlaylistScreenProps) {
  const { playlist } = props;
  const { t, count, runtime } = useI18n();
  const [filter, setFilter] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [limit, setLimit] = useState(FIRST_ROWS);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // The parent passes new callbacks on every render; rows get stable ones that read the latest.
  const propsRef = useRef(props);
  propsRef.current = props;
  const onPlay = useCallback((track: Track) => propsRef.current.onPlay(track), []);
  const onMore = useCallback((track: Track) => propsRef.current.onTrackMore(track), []);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      query
        ? playlist.tracks.filter(
            (track) => track.title.toLowerCase().includes(query) || track.performer.toLowerCase().includes(query),
          )
        : playlist.tracks,
    [playlist.tracks, query],
  );
  const positions = useMemo(() => new Map(playlist.tracks.map((track, index) => [track.id, index])), [playlist.tracks]);
  const seconds = useMemo(() => playlist.tracks.reduce((sum, track) => sum + track.durationSec, 0), [playlist.tracks]);
  const shown = useMemo(() => visible.slice(0, limit), [visible, limit]);
  const hasMore = visible.length > shown.length;

  // Render more rows when the end of the list comes near.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLimit((current) => current + MORE_ROWS);
        }
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, shown.length]);

  const handleDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }
    const ids = propsRef.current.playlist.tracks.map((track) => track.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) {
      propsRef.current.onReorder(arrayMove(ids, from, to));
    }
  }, []);

  const canReorder = !query && !props.readOnly;
  const playingId = props.isPlaying ? props.currentTrackId : null;
  // The list only re-renders when the tracks or the current track change, not on every player tick.
  const list = useMemo(
    () => (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={shown.map((track) => track.id)} strategy={verticalListSortingStrategy}>
          <ol className="tracks">
            {shown.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                index={positions.get(track.id) ?? 0}
                isCurrent={track.id === props.currentTrackId}
                isPlaying={track.id === playingId}
                canReorder={canReorder}
                onPlay={onPlay}
                onMore={onMore}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    ),
    [sensors, handleDragEnd, shown, positions, props.currentTrackId, playingId, canReorder, onPlay, onMore],
  );

  return (
    <div className="playlist">
      <header className="playlist__header">
        <button className="icon-button back-button" type="button" aria-label={t("playlist.back")} onClick={props.onBack}>
          <Icon name="back" />
        </button>
        <Cover playlist={playlist} title={props.title} fallbackIcon={props.icon} large />
        <div className="playlist__meta">
          <span className="eyebrow">{props.context}</span>
          <h2>{props.title}</h2>
          {props.description ? <p>{props.description}</p> : null}
          <p className="muted">
            {count(playlist.tracks.length, "unit.track")}
            {props.loading ? "…" : seconds > 0 ? ` · ${runtime(seconds)}` : ""}
          </p>
        </div>
        <button className="icon-button" type="button" aria-label={t("playlist.options")} onClick={props.onPlaylistMore}>
          <Icon name="more" />
        </button>
      </header>

      <div className="toolbar">
        <button
          className="button button--primary"
          type="button"
          disabled={playlist.tracks.length === 0}
          onClick={props.onPlayAll}
          aria-pressed={props.playingHere}
        >
          <Icon name={props.playingHere ? "pause" : "play"} size={16} />
          <span className="button__label">{t(props.playingHere ? "playlist.stop" : "playlist.play")}</span>
        </button>
        <button
          className="button"
          type="button"
          disabled={playlist.tracks.length < 2 || props.busy === "shuffle"}
          onClick={props.onShuffle}
          aria-label={t("playlist.shuffle")}
          title={t(props.readOnly ? "playlist.shuffleAllHint" : "playlist.shuffleHint")}
        >
          <Icon name="shuffle" size={16} />
          <span className="button__label">{t("playlist.shuffle")}</span>
        </button>
        <button
          className="button"
          type="button"
          disabled={playlist.tracks.length === 0 || props.busy === "send"}
          onClick={props.onSend}
          aria-label={t("playlist.send")}
          title={t("playlist.sendHint")}
        >
          <Icon name="send" size={16} />
          <span className="button__label">{props.busy === "send" ? t("playlist.sending") : t("playlist.send")}</span>
        </button>
      </div>

      {playlist.tracks.length > 6 ? (
        <input
          className="input search"
          type="search"
          placeholder={t("playlist.search")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      ) : null}

      {playlist.tracks.length === 0 ? (
        props.loading ? (
          <div className="hint">
            <div className="spinner" aria-label={t("app.loading")} />
          </div>
        ) : (
          <div className="hint">
            <Icon name="music" size={28} />
            <p>{props.emptyText ?? t("playlist.empty")}</p>
          </div>
        )
      ) : (
        list
      )}
      {hasMore ? <div ref={sentinelRef} className="tracks__more" aria-hidden="true" /> : null}
      {props.loading && playlist.tracks.length > 0 ? <p className="muted tracks__loading">{t("playlist.loadingMore")}</p> : null}
    </div>
  );
}
