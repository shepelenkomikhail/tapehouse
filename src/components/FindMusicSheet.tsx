import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MusicSource, SearchResult, Track } from "../../shared/types";
import { api } from "../lib/api";
import { formatDuration } from "../lib/format";
import { errorMessage, useI18n } from "../lib/i18n";
import { openExternal } from "../lib/telegram";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

const SOURCE_NAMES: Record<MusicSource, string> = {
  audius: "Audius",
  archive: "Internet Archive",
  jamendo: "Jamendo",
};

const keyOf = (result: SearchResult) => `${result.source}:${result.id}`;

/**
 * Demo: search catalogs whose authors allow downloading. "Download" makes the bot send the file to
 * the user's chat (so it lives in Telegram, like everything else) and puts it in the Inbox.
 */
export function FindMusicSheet({
  onClose,
  onAdded,
  onPreviewStart,
  onError,
}: {
  onClose: () => void;
  onAdded: (track: Track, result: SearchResult) => void;
  /** Called when a preview starts, so the main player can pause. */
  onPreviewStart: () => void;
  onError: (text: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [sources, setSources] = useState<MusicSource[]>([]);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchId = useRef(0);

  // Stop the preview when the sheet closes.
  useEffect(() => () => audioRef.current?.pause(), []);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text.length < 2) {
      return;
    }
    const id = ++searchId.current;
    setStatus("searching");
    try {
      const response = await api.searchMusic(text);
      if (id === searchId.current) {
        setResults(response.results);
        setSources(response.sources);
        setStatus("done");
      }
    } catch (error) {
      if (id === searchId.current) {
        setStatus("idle");
        onError(errorMessage(t, error));
      }
    }
  };

  const togglePreview = (result: SearchResult) => {
    if (!result.previewUrl) {
      return;
    }
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.addEventListener("ended", () => setPreviewing(null));
      audioRef.current.addEventListener("error", () => setPreviewing(null));
    }
    const audio = audioRef.current;
    if (previewing === keyOf(result)) {
      audio.pause();
      setPreviewing(null);
      return;
    }
    onPreviewStart();
    audio.src = result.previewUrl;
    void audio.play().catch(() => setPreviewing(null));
    setPreviewing(keyOf(result));
  };

  const add = async (result: SearchResult) => {
    const key = keyOf(result);
    setAdding((current) => new Set(current).add(key));
    try {
      const { track } = await api.addFound(result);
      setAdded((current) => new Set(current).add(key));
      onAdded(track, result);
    } catch (error) {
      onError(errorMessage(t, error));
    } finally {
      setAdding((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <Sheet title={t("find.title")} onClose={onClose}>
      <div className="find">
        <p className="muted">{t("find.demo")}</p>
        <form className="find__form" onSubmit={search}>
          <input
            autoFocus
            className="input"
            type="search"
            value={query}
            maxLength={100}
            placeholder={t("find.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="button button--primary" type="submit" disabled={query.trim().length < 2 || status === "searching"}>
            <Icon name="search" size={16} />
            <span className="button__label">{status === "searching" ? t("find.searching") : t("find.search")}</span>
          </button>
        </form>

        {status === "done" && results.length === 0 ? <p className="muted">{t("find.nothing")}</p> : null}

        {results.length > 0 ? (
          <ul className="find__results">
            {results.map((result) => {
              const key = keyOf(result);
              const isAdding = adding.has(key);
              const isAdded = added.has(key);
              return (
                <li key={key} className="find__item">
                  <button
                    className="find__cover"
                    type="button"
                    disabled={!result.previewUrl}
                    aria-label={previewing === key ? t("find.stopPreview") : t("find.preview")}
                    title={previewing === key ? t("find.stopPreview") : t("find.preview")}
                    onClick={() => togglePreview(result)}
                    style={result.artworkUrl ? { backgroundImage: `url("${result.artworkUrl}")` } : undefined}
                  >
                    <span className="find__cover-icon">
                      <Icon name={previewing === key ? "pause" : "play"} size={16} />
                    </span>
                  </button>
                  <span className="find__text">
                    <strong>{result.title}</strong>
                    <span>
                      {result.performer}
                      {result.durationSec ? ` · ${formatDuration(result.durationSec)}` : ""}
                    </span>
                    <a
                      href={result.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        openExternal(result.pageUrl);
                      }}
                    >
                      {SOURCE_NAMES[result.source]} · {result.license}
                    </a>
                  </span>
                  <button
                    className={`icon-button find__add${isAdded ? " find__add--done" : ""}`}
                    type="button"
                    disabled={isAdding || isAdded}
                    aria-label={isAdded ? t("find.added") : isAdding ? t("find.adding") : t("find.add")}
                    title={isAdded ? t("find.added") : isAdding ? t("find.adding") : t("find.add")}
                    onClick={() => void add(result)}
                  >
                    {isAdding ? <span className="spinner spinner--small" /> : <Icon name={isAdded ? "check" : "plus"} />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {sources.length > 0 ? (
          <p className="muted find__sources">
            {t("find.sources", { sources: sources.map((source) => SOURCE_NAMES[source]).join(", ") })}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
