import { useState, type FormEvent } from "react";
import { sameRef, type PlaylistRef } from "../hooks/usePlayer";
import { useI18n } from "../lib/i18n";
import { Sheet } from "./Sheet";

export interface PlaylistChoice {
  ref: PlaylistRef;
  label: string;
  group?: string;
  trackCount: number;
}

/** Pick several playlists and a name; the caller creates a new playlist with all their tracks. */
export function MergeSheet({
  choices,
  initial,
  onClose,
  onMerge,
}: {
  choices: PlaylistChoice[];
  initial: PlaylistRef;
  onClose: () => void;
  onMerge: (refs: PlaylistRef[], title: string) => void;
}) {
  const { t, count } = useI18n();
  const [picked, setPicked] = useState<PlaylistRef[]>([initial]);
  const [customTitle, setCustomTitle] = useState<string | null>(null);

  const isPicked = (ref: PlaylistRef) => picked.some((item) => sameRef(item, ref));
  // Keep the picking order, so the name reads in the order the playlists were ticked.
  const autoTitle = picked
    .map((ref) => choices.find((choice) => sameRef(choice.ref, ref))?.label ?? "")
    .filter(Boolean)
    .join(" + ")
    .slice(0, 80);
  const title = customTitle ?? autoTitle;

  const toggle = (ref: PlaylistRef) =>
    setPicked((current) => (isPicked(ref) ? current.filter((item) => !sameRef(item, ref)) : [...current, ref]));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (picked.length >= 2 && title.trim()) {
      onMerge(picked, title.trim());
    }
  };

  return (
    <Sheet title={t("merge.title")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">{t("merge.explain")}</p>
        <ul className="check-list">
          {choices.map((choice) => (
            <li key={`${choice.ref.kind}:${"chatId" in choice.ref ? choice.ref.chatId : ""}:${choice.ref.playlistId}`}>
              <label className="check-item">
                <input type="checkbox" checked={isPicked(choice.ref)} onChange={() => toggle(choice.ref)} />
                <span className="check-item__text">
                  <strong>{choice.label}</strong>
                  <span>
                    {count(choice.trackCount, "unit.track")}
                    {choice.group ? ` · ${choice.group}` : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <label className="field">
          <span>{t("merge.name")}</span>
          <input
            className="input"
            value={title}
            maxLength={80}
            onChange={(event) => setCustomTitle(event.target.value)}
          />
        </label>
        <button className="button button--primary" type="submit" disabled={picked.length < 2 || !title.trim()}>
          {picked.length < 2 ? t("merge.pickTwo") : t("merge.create")}
        </button>
      </form>
    </Sheet>
  );
}
