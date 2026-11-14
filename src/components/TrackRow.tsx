import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Track } from "../../shared/types";
import { formatDuration } from "../lib/format";
import { Icon } from "./Icon";

interface TrackRowProps {
  track: Track;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  canReorder: boolean;
  onPlay: () => void;
  onMore: () => void;
}

export function TrackRow({ track, index, isCurrent, isPlaying, canReorder, onPlay, onMore }: TrackRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: track.id, disabled: !canReorder });

  return (
    <li
      ref={setNodeRef}
      className={`track${isCurrent ? " track--current" : ""}${isDragging ? " track--dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {canReorder ? (
        <button
          ref={setActivatorNodeRef}
          className="track__handle"
          type="button"
          aria-label={`Move ${track.title}`}
          {...attributes}
          {...listeners}
        >
          <Icon name="drag" size={18} />
        </button>
      ) : null}

      <button className="track__main" type="button" onClick={onPlay}>
        <span className="track__index" aria-hidden="true">
          {isCurrent && isPlaying ? <span className="eq"><i /><i /><i /></span> : index + 1}
        </span>
        <span className="track__text">
          <span className="track__title">{track.title}</span>
          <span className="track__artist">{track.performer}</span>
        </span>
        <span className="track__time">{track.durationSec ? formatDuration(track.durationSec) : ""}</span>
      </button>

      <button className="icon-button" type="button" aria-label={`More actions for ${track.title}`} onClick={onMore}>
        <Icon name="more" size={18} />
      </button>
    </li>
  );
}
