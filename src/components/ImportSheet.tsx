import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage, useI18n } from "../lib/i18n";
import { Sheet } from "./Sheet";

interface ImportSheetProps {
  chatId: string;
  chatTitle: string;
  onClose: () => void;
  /** Called after each batch that added tracks, so the playlist refreshes as it fills. */
  onProgress: () => void;
}

type Status = "idle" | "running" | "done" | "stopped" | "error";

/** Drives /api/import batch by batch, showing progress. Closing the sheet stops it. */
export function ImportSheet({ chatId, chatTitle, onClose, onProgress }: ImportSheetProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>("idle");
  const [scanned, setScanned] = useState(0);
  const [last, setLast] = useState<number | null>(null);
  const [found, setFound] = useState(0);
  const [added, setAdded] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  // Kept across Stop/Start so a stopped import resumes where it left off.
  const fromRef = useRef(1);
  const missesRef = useRef(0);

  useEffect(() => () => {
    stopRef.current = true; // unmounting (sheet closed) stops the loop
  }, []);

  const run = async () => {
    stopRef.current = false;
    setStatus("running");
    setError(null);
    while (!stopRef.current) {
      try {
        const batch = await api.importHistory(chatId, fromRef.current, missesRef.current);
        setScanned(batch.next - 1);
        setLast(batch.last);
        setFound((value) => value + batch.found);
        if (batch.added > 0) {
          setAdded((value) => value + batch.added);
          onProgress();
        }
        fromRef.current = batch.next;
        missesRef.current = batch.misses;
        if (batch.done) {
          setStatus("done");
          onProgress();
          return;
        }
        if (batch.retryAfter > 0) {
          for (let left = batch.retryAfter; left > 0 && !stopRef.current; left -= 1) {
            setWaiting(left);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          setWaiting(0);
        }
      } catch (err) {
        setError(errorMessage(t, err));
        setStatus("error");
        return;
      }
    }
    setStatus("stopped");
  };

  return (
    <Sheet title={t("import.title")} subtitle={chatTitle} onClose={onClose}>
      <div className="form">
        {status === "idle" ? <p className="muted">{t("import.explain")}</p> : null}

        {status !== "idle" ? (
          <div className="import-progress">
            <p>
              {t("import.progress", {
                scanned,
                of: last ? t("import.of", { last }) : "",
              })}
            </p>
            {last ? (
              <div className="import-progress__bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (scanned / last) * 100)}%` }} />
              </div>
            ) : null}
            <p className="muted">{t("import.found", { found, added })}</p>
            {waiting > 0 ? <p className="muted">{t("import.waiting", { seconds: waiting })}</p> : null}
            {status === "done" ? <p><strong>{t("import.done")}</strong></p> : null}
            {status === "stopped" ? <p className="muted">{t("import.stopped")}</p> : null}
            {error ? <p className="import-progress__error">{error}</p> : null}
          </div>
        ) : null}

        {status === "running" ? (
          <button className="button" type="button" onClick={() => (stopRef.current = true)}>
            {t("import.stop")}
          </button>
        ) : status === "done" ? (
          <button className="button button--primary" type="button" onClick={onClose}>
            {t("import.close")}
          </button>
        ) : (
          <button className="button button--primary" type="button" onClick={() => void run()}>
            {t("import.start")}
          </button>
        )}
      </div>
    </Sheet>
  );
}
