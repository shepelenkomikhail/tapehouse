import type { PlayerState } from "../hooks/usePlayer";
import { formatDuration } from "../lib/format";
import { Icon } from "./Icon";

interface PlayerBarProps {
  state: PlayerState;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
}

export function PlayerBar({ state, onToggle, onNext, onPrevious, onSeek }: PlayerBarProps) {
  if (!state.track) {
    return null;
  }

  const duration = Math.max(state.duration || state.track.durationSec, 1);
  const progress = Math.min(state.time / duration, 1);

  return (
    <section className="player" aria-label="Player">
      <input
        className="player__seek"
        type="range"
        min={0}
        max={duration}
        step={1}
        value={Math.min(state.time, duration)}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Seek"
        style={{ "--progress": `${progress * 100}%` } as React.CSSProperties}
      />
      <div className="player__row">
        <div className="player__text">
          <strong>{state.track.title}</strong>
          <span>
            {state.track.performer} · {formatDuration(state.time)} / {formatDuration(duration)}
          </span>
        </div>
        <div className="player__controls">
          <button className="icon-button" type="button" aria-label="Previous" onClick={onPrevious}>
            <Icon name="prev" />
          </button>
          <button
            className={`play-button${state.buffering ? " play-button--busy" : ""}`}
            type="button"
            aria-label={state.playing ? "Pause" : "Play"}
            onClick={onToggle}
          >
            <Icon name={state.playing ? "pause" : "play"} size={22} />
          </button>
          <button className="icon-button" type="button" aria-label="Next" onClick={onNext}>
            <Icon name="next" />
          </button>
        </div>
      </div>
    </section>
  );
}
