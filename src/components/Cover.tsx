import { firstGrapheme } from "../../shared/playlist-ops";
import type { Playlist } from "../../shared/types";
import { Icon } from "./Icon";

/**
 * Playlist cover: the chosen emoji, or the first character of the title on the accent color.
 * Nothing is uploaded or stored besides the emoji itself.
 */
export function Cover({
  playlist,
  title,
  fallbackIcon,
  large,
}: {
  playlist: Pick<Playlist, "accent" | "emoji">;
  title: string;
  fallbackIcon?: "inbox" | "library";
  large?: boolean;
}) {
  const glyph = playlist.emoji ? null : firstGrapheme(title).toUpperCase();
  return (
    <span
      className={`cover${large ? " cover--large" : ""}${playlist.emoji ? " cover--emoji" : ""}`}
      style={{ background: playlist.accent }}
      aria-hidden="true"
    >
      {playlist.emoji ?? (fallbackIcon ? <Icon name={fallbackIcon} size={large ? 32 : 20} /> : glyph)}
    </span>
  );
}
