import type { Track } from "../../shared/types";

/** Same name regardless of case, extra spaces or Unicode look-alikes ("ё" stays as written). */
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

/** The same audio file (re-sent or forwarded copies share it). */
export const fileKey = (track: Track) => track.fileUniqueId ?? track.fileId;

/**
 * Groups tracks that are copies of each other: the same file, OR the same title + performer
 * (ignoring case). Groups keep playlist order, so the first track is the one to keep by default.
 * Only groups with at least two tracks are returned, in the order they first appear.
 */
export function findDuplicates(tracks: Track[]): Track[][] {
  const parent = tracks.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (a: number, b: number) => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) {
      parent[Math.max(ra, rb)] = Math.min(ra, rb); // the earliest track becomes the group's root
    }
  };

  const firstByKey = new Map<string, number>();
  tracks.forEach((track, index) => {
    const title = normalize(track.title);
    const keys = [`f:${fileKey(track)}`];
    if (title) {
      keys.push(`n:${title}\u0000${normalize(track.performer)}`);
    }
    for (const key of keys) {
      const first = firstByKey.get(key);
      if (first === undefined) {
        firstByKey.set(key, index);
      } else {
        join(first, index);
      }
    }
  });

  const groups = new Map<number, Track[]>();
  tracks.forEach((track, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), track]);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}
