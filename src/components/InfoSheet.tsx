import { useI18n } from "../lib/i18n";
import { Sheet } from "./Sheet";

const SECTIONS = [
  ["info.addTitle", "info.addBody"],
  ["info.playlistsTitle", "info.playlistsBody"],
  ["info.mergeTitle", "info.mergeBody"],
  ["info.allTitle", "info.allBody"],
  ["info.listenTitle", "info.listenBody"],
  ["info.groupsTitle", "info.groupsBody"],
  ["info.otherTitle", "info.otherBody"],
] as const;

/** Instructions for everything in the app, opened from the ⓘ button on the home screen. */
export function InfoSheet({ botUsername, onClose }: { botUsername?: string; onClose: () => void }) {
  const { t } = useI18n();
  const vars = { bot: botUsername ? `@${botUsername}` : "bot", botName: botUsername ?? "bot" };
  return (
    <Sheet title={t("info.title")} onClose={onClose}>
      <div className="info">
        {SECTIONS.map(([title, body]) => (
          <section key={title} className="info__section">
            <h3>{t(title)}</h3>
            <p className="muted muted--pre">{t(body, vars)}</p>
          </section>
        ))}
        <button className="button button--primary" type="button" onClick={onClose}>
          {t("info.close")}
        </button>
      </div>
    </Sheet>
  );
}
