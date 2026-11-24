import type { MusicSource, SearchResult } from "../../shared/types.js";
import { getEnv } from "./env.js";

/**
 * "Find music": catalogs whose authors allow downloading, so a found track can be sent into the
 * user's Telegram and kept. Search results carry only ids; the download link is always looked up
 * again on the server, so the client can never make the bot fetch an arbitrary URL.
 */

const APP_NAME = "tapehouse";
/** Bots may upload up to 50 MB; leave room for the request around the file. */
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

export interface ResolvedTrack {
  url: string;
  title: string;
  performer: string;
  durationSec: number;
  license: string;
  pageUrl: string;
  fileName: string;
}

export class SourceError extends Error {}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new SourceError(`${new URL(url).host} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export function enabledSources(): MusicSource[] {
  return getEnv().jamendoClientId ? ["jamendo", "audius", "archive"] : ["audius", "archive"];
}

/** "creativecommons.org/licenses/by-nc/4.0/" → "CC BY-NC 4.0"; public domain marks → "Public domain". */
export function licenseLabel(url: string | undefined) {
  if (!url) {
    return "";
  }
  if (/publicdomain/i.test(url)) {
    return "Public domain";
  }
  const match = /licenses\/([a-z-]+)\/([\d.]+)/i.exec(url);
  return match ? `CC ${match[1].toUpperCase()} ${match[2]}` : url;
}

const safeName = (text: string) => text.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "track";

// ---------- Audius: independent artists; only tracks the artist made downloadable ----------

interface AudiusTrack {
  id: string;
  title: string;
  duration: number;
  is_downloadable?: boolean;
  license?: string | null;
  permalink: string;
  artwork?: Record<string, string> | null;
  stream?: { url?: string } | null;
  user: { name: string; handle: string };
}

const AUDIUS = "https://api.audius.co/v1";
const audiusLicense = (license?: string | null) =>
  license && license !== "All rights reserved" ? license : "Download allowed by the artist";

async function searchAudius(query: string): Promise<SearchResult[]> {
  const { data } = await getJson<{ data: AudiusTrack[] }>(
    `${AUDIUS}/tracks/search?${new URLSearchParams({ query, app_name: APP_NAME, limit: "50" })}`,
  );
  return data
    .filter((track) => track.is_downloadable)
    .slice(0, 15)
    .map((track) => ({
      source: "audius",
      id: track.id,
      title: track.title,
      performer: track.user.name,
      durationSec: Math.round(track.duration ?? 0),
      license: audiusLicense(track.license),
      pageUrl: `https://audius.co${track.permalink}`,
      artworkUrl: track.artwork?.["150x150"],
      previewUrl: `${AUDIUS}/tracks/${encodeURIComponent(track.id)}/stream?app_name=${APP_NAME}`,
    }));
}

async function resolveAudius(id: string): Promise<ResolvedTrack> {
  if (!/^[A-Za-z0-9]{1,20}$/.test(id)) {
    throw new SourceError("Bad track id.");
  }
  const { data: track } = await getJson<{ data: AudiusTrack }>(`${AUDIUS}/tracks/${id}?app_name=${APP_NAME}`);
  if (!track.is_downloadable) {
    throw new SourceError("The artist doesn't allow downloading this track.");
  }
  return {
    // The MP3 stream of the track; Telegram plays MP3 natively (the original upload may be WAV).
    url: track.stream?.url ?? `${AUDIUS}/tracks/${id}/stream?app_name=${APP_NAME}`,
    title: track.title,
    performer: track.user.name,
    durationSec: Math.round(track.duration ?? 0),
    license: audiusLicense(track.license),
    pageUrl: `https://audius.co${track.permalink}`,
    fileName: `${safeName(`${track.user.name} - ${track.title}`)}.mp3`,
  };
}

// ---------- Internet Archive: netlabels and other openly licensed music ----------

interface ArchiveFile {
  name: string;
  format?: string;
  title?: string;
  creator?: string;
  artist?: string;
  length?: string;
  size?: string;
  track?: string;
}

interface ArchiveItem {
  metadata?: { title?: string; creator?: string | string[]; licenseurl?: string };
  files?: ArchiveFile[];
}

const ARCHIVE_MP3 = ["VBR MP3", "128Kbps MP3", "MP3"];

/** "07:02" → 422, "201.4" → 201. */
function parseLength(length?: string) {
  if (!length) {
    return 0;
  }
  if (length.includes(":")) {
    return length.split(":").reduce((total, part) => total * 60 + Number(part || 0), 0);
  }
  return Math.round(Number(length) || 0);
}

/** One MP3 per track: prefer the best-quality derivative the item has. */
function archiveTracks(item: ArchiveItem) {
  const files = item.files ?? [];
  const format = ARCHIVE_MP3.find((candidate) => files.some((file) => file.format === candidate));
  return format
    ? files
        .filter((file) => file.format === format && Number(file.size ?? 0) <= MAX_UPLOAD_BYTES)
        .sort((a, b) => Number(a.track ?? 0) - Number(b.track ?? 0) || a.name.localeCompare(b.name))
    : [];
}

const firstCreator = (creator?: string | string[]) => (Array.isArray(creator) ? creator[0] : creator) ?? "";
const archiveFileUrl = (identifier: string, name: string) =>
  `https://archive.org/download/${identifier}/${name.split("/").map(encodeURIComponent).join("/")}`;
/** The file's own title tag, or a tidied file name: "dr06_01_la_flaque_vbr.mp3" → "la flaque". */
function fileTitle(file: ArchiveFile) {
  if (file.title) {
    return file.title;
  }
  const base = file.name.split("/").pop() ?? file.name;
  const tidy = base
    .replace(/\.mp3$/i, "")
    .replace(/[_ ](vbr|64kb|128kb)$/i, "")
    .replace(/^[a-z]{0,4}\d*[_ -]+\d{1,3}[_ .-]+/i, "") // catalogue number + track number prefix
    .replace(/^\d{1,3}\s*[-._ ]\s*/, "")
    .replace(/_+/g, " ")
    .trim();
  return tidy || base;
}

async function searchArchive(query: string): Promise<SearchResult[]> {
  // Lucene syntax is not for end users: keep only words.
  const words = query.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").trim();
  if (!words) {
    return [];
  }
  const q =
    `(${words}) AND mediatype:audio AND licenseurl:* AND format:"VBR MP3" ` +
    "AND (collection:netlabels OR collection:audio_music OR collection:opensource_audio) " +
    "AND -collection:librivoxaudio AND -collection:podcasts";
  const params = new URLSearchParams({ q, rows: "6", output: "json" });
  params.append("fl[]", "identifier");
  const { response } = await getJson<{ response: { docs: { identifier: string }[] } }>(
    `https://archive.org/advancedsearch.php?${params}`,
  );

  // Search finds albums; open each one to list its tracks.
  const items = await Promise.all(
    response.docs.map(async ({ identifier }) => {
      try {
        const item = await getJson<ArchiveItem>(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, 6000);
        const license = licenseLabel(item.metadata?.licenseurl);
        if (!license) {
          return [];
        }
        const albumArtist = firstCreator(item.metadata?.creator);
        return archiveTracks(item)
          .slice(0, 4)
          .map<SearchResult>((file) => ({
            source: "archive",
            id: `${identifier}/${file.name}`,
            title: fileTitle(file),
            performer: file.creator || file.artist || albumArtist || "Unknown artist",
            durationSec: parseLength(file.length),
            license,
            pageUrl: `https://archive.org/details/${identifier}`,
            artworkUrl: `https://archive.org/services/img/${identifier}`,
            previewUrl: archiveFileUrl(identifier, file.name),
          }));
      } catch {
        return [];
      }
    }),
  );
  return items.flat();
}

async function resolveArchive(id: string): Promise<ResolvedTrack> {
  const slash = id.indexOf("/");
  const identifier = id.slice(0, slash);
  const name = id.slice(slash + 1);
  if (slash < 1 || !/^[\w.-]{1,100}$/.test(identifier) || !name || name.length > 300) {
    throw new SourceError("Bad track id.");
  }
  const item = await getJson<ArchiveItem>(`https://archive.org/metadata/${identifier}`);
  const license = licenseLabel(item.metadata?.licenseurl);
  const file = archiveTracks(item).find((candidate) => candidate.name === name);
  if (!license || !file) {
    throw new SourceError("This file isn't available.");
  }
  const title = fileTitle(file);
  const performer = file.creator || file.artist || firstCreator(item.metadata?.creator) || "Unknown artist";
  return {
    url: archiveFileUrl(identifier, file.name),
    title,
    performer,
    durationSec: parseLength(file.length),
    license,
    pageUrl: `https://archive.org/details/${identifier}`,
    fileName: `${safeName(`${performer} - ${title}`)}.mp3`,
  };
}

// ---------- Jamendo: Creative Commons catalog (needs JAMENDO_CLIENT_ID) ----------

interface JamendoTrack {
  id: string;
  name: string;
  artist_name: string;
  duration: number;
  audio: string;
  audiodownload: string;
  audiodownload_allowed: boolean;
  license_ccurl: string;
  shareurl: string;
  image?: string;
}

async function jamendo(params: Record<string, string>) {
  const clientId = getEnv().jamendoClientId;
  if (!clientId) {
    throw new SourceError("Jamendo is not configured.");
  }
  const query = new URLSearchParams({ client_id: clientId, format: "json", audiodownload_allowed: "true", ...params });
  return (await getJson<{ results: JamendoTrack[] }>(`https://api.jamendo.com/v3.0/tracks/?${query}`)).results;
}

async function searchJamendo(query: string): Promise<SearchResult[]> {
  return (await jamendo({ search: query, limit: "15" })).map((track) => ({
    source: "jamendo",
    id: String(track.id),
    title: track.name,
    performer: track.artist_name,
    durationSec: track.duration,
    license: licenseLabel(track.license_ccurl),
    pageUrl: track.shareurl,
    artworkUrl: track.image || undefined,
    previewUrl: track.audio,
  }));
}

async function resolveJamendo(id: string): Promise<ResolvedTrack> {
  if (!/^\d{1,12}$/.test(id)) {
    throw new SourceError("Bad track id.");
  }
  const [track] = await jamendo({ id });
  if (!track?.audiodownload_allowed || !track.audiodownload) {
    throw new SourceError("The artist doesn't allow downloading this track.");
  }
  return {
    url: track.audiodownload,
    title: track.name,
    performer: track.artist_name,
    durationSec: track.duration,
    license: licenseLabel(track.license_ccurl),
    pageUrl: track.shareurl,
    fileName: `${safeName(`${track.artist_name} - ${track.name}`)}.mp3`,
  };
}

// ---------- Public API ----------

const SEARCH: Record<MusicSource, (query: string) => Promise<SearchResult[]>> = {
  audius: searchAudius,
  archive: searchArchive,
  jamendo: searchJamendo,
};

const RESOLVE: Record<MusicSource, (id: string) => Promise<ResolvedTrack>> = {
  audius: resolveAudius,
  archive: resolveArchive,
  jamendo: resolveJamendo,
};

/** Searches every enabled catalog at once; a catalog that fails or is slow is just left out. */
export async function searchMusic(query: string) {
  const sources = enabledSources();
  const lists = await Promise.all(
    sources.map((source) =>
      SEARCH[source](query).catch((error) => {
        console.error(`Search in ${source} failed`, error);
        return [] as SearchResult[];
      }),
    ),
  );
  // Interleave, so one catalog doesn't push the others below the fold.
  const results: SearchResult[] = [];
  for (let index = 0; lists.some((list) => index < list.length); index += 1) {
    for (const list of lists) {
      if (list[index]) {
        results.push(list[index]);
      }
    }
  }
  return { results, sources };
}

export function resolveTrack(source: MusicSource, id: string) {
  if (!enabledSources().includes(source)) {
    throw new SourceError("This catalog is not available.");
  }
  return RESOLVE[source](id);
}
