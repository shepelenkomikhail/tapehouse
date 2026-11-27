import { useMemo, useState } from "react";
import type { Track } from "../../shared/types";
import { findDuplicates } from "../lib/duplicates";
import { formatDuration } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { Sheet } from "./Sheet";

/**
 * Lists copies of the same song in a playlist (same file, or same title + performer in any case)
 * and lets you choose which to remove. By default the first copy of each song stays.
 */
export function DuplicatesSheet({
  tracks,
  subtitle,
  note,
  loading,
  onClose,
  onRemove,
}: {
  tracks: Track[];
  subtitle: string;
  /** Extra warning, e.g. that removing from "All music" removes from every playlist. */
  note?: string;
  /** The playlist is still loading, so the check can't be complete yet. */
  loading?: boolean;
  onClose: () => void;
  onRemove: (tracks: Track[]) => void;
}) {
  const { t, count } = useI18n();
  const groups = useMemo(() => findDuplicates(tracks), [tracks]);
  const [removing, setRemoving] = useState<Set<string>>(
    () => new Set(groups.flatMap((group) => group.slice(1).map((track) => track.id))),
  );

  const toggle = (id: string) =>
    setRemoving((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const selected = tracks.filter((track) => removing.has(track.id));

  if (loading) {
    return (
      <Sheet title={t("dupes.title")} subtitle={subtitle} onClose={onClose}>
        <p className="muted">{t("dupes.loading")}</p>
      </Sheet>
    );
  }

  if (groups.length === 0) {
    return (
      <Sheet title={t("dupes.title")} subtitle={subtitle} onClose={onClose}>
        <p className="muted">{t("dupes.none")}</p>
        <button className="button" type="button" onClick={onClose}>
          {t("dupes.close")}
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title={t("dupes.title")} subtitle={subtitle} onClose={onClose}>
      <div className="form">
        <p className="muted">
          {t("dupes.found", {
            songs: count(groups.length, "unit.song"),
            copies: count(groups.reduce((sum, group) => sum + group.length - 1, 0), "unit.copy"),
          })}
        </p>
        {note ? <p className="muted">{note}</p> : null}
        <div className="dupes">
          {groups.map((group) => (
            <ul className="check-list dupes__group" key={group[0].id}>
              {group.map((track) => (
                <li key={track.id}>
                  <label className="check-item">
                    <input type="checkbox" checked={removing.has(track.id)} onChange={() => toggle(track.id)} />
                    <span className="check-item__text">
                      <strong>{track.title}</strong>
                      <span>
                        {[track.performer, track.durationSec ? formatDuration(track.durationSec) : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className={`dupes__tag${removing.has(track.id) ? " dupes__tag--remove" : ""}`}>
                      {t(removing.has(track.id) ? "dupes.remove" : "dupes.keep")}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ))}
        </div>
        <button
          className="button button--danger"
          type="button"
          disabled={selected.length === 0}
          onClick={() => onRemove(selected)}
        >
          {t("dupes.removeSelected", { count: count(selected.length, "unit.track") })}
        </button>
        <button className="button" type="button" onClick={onClose}>
          {t("dupes.keepAll")}
        </button>
      </div>
    </Sheet>
  );
}
