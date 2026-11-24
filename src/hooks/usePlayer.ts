import { useCallback, useEffect, useRef, useState } from "react";
import { smartShuffle } from "../../shared/playlist-ops";
import type { Playlist, Track } from "../../shared/types";
import { streamUrl } from "../lib/api";
import { loadSetting, saveSetting } from "../lib/cloud-storage";

export type PlaylistRef =
  | { kind: "personal"; playlistId: string }
  | { kind: "group"; chatId: string; playlistId: string }
  /** "All music": every track from every playlist, each file once. Read-only, built on the fly. */
  | { kind: "all"; playlistId: "all" };

export const ALL_REF: PlaylistRef = { kind: "all", playlistId: "all" };

export function sameRef(a: PlaylistRef | null, b: PlaylistRef | null) {
  return (
    !!a &&
    !!b &&
    a.kind === b.kind &&
    a.playlistId === b.playlistId &&
    (a.kind !== "group" || a.chatId === (b as { chatId: string }).chatId)
  );
}

export interface PlayerState {
  source: PlaylistRef | null;
  track: Track | null;
  playing: boolean;
  buffering: boolean;
  time: number;
  duration: number;
  error: string | null;
  /** Plays in a random order for this session only; the playlist's saved order is untouched. */
  shuffle: boolean;
}

const refKey = (ref: PlaylistRef) =>
  ref.kind === "group" ? `g:${ref.chatId}:${ref.playlistId}` : ref.kind === "all" ? "all" : `p:${ref.playlistId}`;

/** Where listening stopped, so reopening the app shows the player ready to continue. */
interface ResumePoint {
  source: PlaylistRef;
  trackId: string;
  time: number;
  shuffle?: boolean;
  /** When it was saved (ms), so the newer of the device copy and the synced copy wins. */
  at: number;
}

// Not "tapehouse:…": that prefix is the browser fallback for CloudStorage, whose cleanup would remove it.
const LOCAL_RESUME_KEY = "tapehouse.resume";
const CLOUD_SAVE_EVERY_MS = 20_000;

function parseResume(raw: string | null | undefined): ResumePoint | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as ResumePoint;
    return value && value.source && typeof value.trackId === "string" ? value : null;
  } catch {
    return null;
  }
}

function readLocalResume() {
  try {
    return parseResume(localStorage.getItem(LOCAL_RESUME_KEY));
  } catch {
    return null;
  }
}

function writeLocalResume(value: ResumePoint | null) {
  try {
    if (value) {
      localStorage.setItem(LOCAL_RESUME_KEY, JSON.stringify(value));
    } else {
      localStorage.removeItem(LOCAL_RESUME_KEY);
    }
  } catch {
    // storage blocked: resume just won't survive a restart on this device
  }
}

/** Current track first, the rest smart-shuffled (no artist twice in a row when avoidable). */
function shuffledOrder(playlist: Playlist, firstId?: string) {
  const rest = playlist.tracks.filter((track) => track.id !== firstId);
  return [...(firstId ? [firstId] : []), ...smartShuffle(rest).map((track) => track.id)];
}

/**
 * Plays a playlist with a single <audio> element. Normally the queue is the *current* order of the
 * source playlist, so reordering while listening changes what plays next. With shuffle on, a random
 * order is kept in memory only (tracks added meanwhile are appended, removed ones skipped).
 */
export function usePlayer(resolve: (ref: PlaylistRef) => Playlist | undefined) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const [state, setState] = useState<PlayerState>({
    source: null,
    track: null,
    playing: false,
    buffering: false,
    time: 0,
    duration: 0,
    error: null,
    shuffle: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const orderRef = useRef<{ key: string; ids: string[] } | null>(null);
  /** A saved spot waiting for its playlist to load (group playlists arrive after startup). */
  const pendingResumeRef = useRef<ResumePoint | null>(null);
  /** Position to jump to once the restored track's audio is loaded. */
  const pendingSeekRef = useRef<number | null>(null);
  /** Set once the user does anything with the player; until then a restored spot isn't re-saved. */
  const interactedRef = useRef(false);

  /** The play order for a source: the shuffled order if active, otherwise the playlist order. */
  const queueFor = useCallback((source: PlaylistRef, playlist: Playlist) => {
    const order = orderRef.current;
    if (!stateRef.current.shuffle || !order || order.key !== refKey(source)) {
      return playlist.tracks;
    }
    const byId = new Map(playlist.tracks.map((track) => [track.id, track]));
    const inOrder = order.ids.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track));
    const listed = new Set(order.ids);
    return [...inOrder, ...playlist.tracks.filter((track) => !listed.has(track.id))];
  }, []);

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    return audioRef.current;
  }, []);

  const play = useCallback(
    (source: PlaylistRef, track: Track) => {
      interactedRef.current = true;
      pendingResumeRef.current = null;
      pendingSeekRef.current = null;
      // Starting a different playlist with shuffle on gets a fresh random order from this track.
      if (stateRef.current.shuffle && orderRef.current?.key !== refKey(source)) {
        const playlist = resolveRef.current(source);
        orderRef.current = playlist ? { key: refKey(source), ids: shuffledOrder(playlist, track.id) } : null;
      }
      const audio = getAudio();
      const url = streamUrl(track);
      if (!audio.src.endsWith(url)) {
        audio.src = url;
      }
      setState((current) => ({
        ...current,
        source,
        track,
        time: 0,
        duration: track.durationSec,
        buffering: true,
        error: null,
      }));
      audio.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return; // superseded by another play() call
        }
        setState((current) => ({ ...current, playing: false, buffering: false }));
      });
    },
    [getAudio],
  );

  const step = useCallback(
    (offset: 1 | -1) => {
      const { source, track } = stateRef.current;
      if (!source || !track) {
        return;
      }
      const playlist = resolveRef.current(source);
      if (!playlist) {
        return;
      }
      const queue = queueFor(source, playlist);
      const index = queue.findIndex((item) => item.id === track.id);
      const next = queue[index + offset];
      if (next) {
        play(source, next);
      } else if (offset === 1) {
        getAudio().pause();
      }
    },
    [getAudio, play, queueFor],
  );

  const toggleShuffle = useCallback(() => {
    const { shuffle, source, track } = stateRef.current;
    interactedRef.current = true;
    if (shuffle) {
      orderRef.current = null;
    } else if (source) {
      const playlist = resolveRef.current(source);
      orderRef.current = playlist ? { key: refKey(source), ids: shuffledOrder(playlist, track?.id) } : null;
    }
    setState((current) => ({ ...current, shuffle: !shuffle }));
  }, []);

  /** Picks where "Play" on a whole playlist starts: a random track when shuffle is on. */
  const firstTrack = useCallback((playlist: Playlist) => {
    if (!stateRef.current.shuffle || playlist.tracks.length === 0) {
      return playlist.tracks[0];
    }
    return playlist.tracks[Math.floor(Math.random() * playlist.tracks.length)];
  }, []);

  /** Plays a playlist in a fresh random order (session only), starting from a random track. */
  const playShuffled = useCallback(
    (source: PlaylistRef) => {
      const playlist = resolveRef.current(source);
      if (!playlist || playlist.tracks.length === 0) {
        return;
      }
      const first = playlist.tracks[Math.floor(Math.random() * playlist.tracks.length)];
      orderRef.current = { key: refKey(source), ids: shuffledOrder(playlist, first.id) };
      stateRef.current = { ...stateRef.current, shuffle: true };
      setState((current) => ({ ...current, shuffle: true }));
      play(source, first);
    },
    [play],
  );

  const toggle = useCallback(() => {
    const audio = getAudio();
    const { track } = stateRef.current;
    if (!track) {
      return;
    }
    interactedRef.current = true;
    if (!audio.getAttribute("src")) {
      // A restored track: load it only now, then jump to where listening stopped.
      audio.src = streamUrl(track);
      setState((current) => ({ ...current, buffering: true, error: null }));
    }
    if (audio.paused) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, [getAudio]);

  const seek = useCallback(
    (seconds: number) => {
      interactedRef.current = true;
      const audio = getAudio();
      if (audio.getAttribute("src") && pendingSeekRef.current === null) {
        audio.currentTime = seconds;
      } else {
        pendingSeekRef.current = seconds; // restored track not loaded yet
      }
      setState((current) => ({ ...current, time: seconds }));
    },
    [getAudio],
  );

  const previous = useCallback(() => {
    if (stateRef.current.time > 4) {
      seek(0);
    } else {
      step(-1);
    }
  }, [seek, step]);

  const stop = useCallback(() => {
    const audio = getAudio();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    orderRef.current = null;
    interactedRef.current = true;
    pendingResumeRef.current = null;
    pendingSeekRef.current = null;
    setState((current) => ({ ...current, source: null, track: null, playing: false, time: 0 }));
  }, [getAudio]);

  // ---------- Remember where listening stopped ----------

  /** Shows the saved track in the player, paused at the saved spot, once its playlist is loaded. */
  const tryRestore = useCallback(() => {
    const saved = pendingResumeRef.current;
    if (!saved) {
      return;
    }
    if (interactedRef.current) {
      pendingResumeRef.current = null; // the user already started something else
      return;
    }
    const playlist = resolveRef.current(saved.source);
    const track = playlist?.tracks.find((item) => item.id === saved.trackId);
    if (!playlist || !track) {
      return; // not loaded yet (or gone); try again when playlists change
    }
    pendingResumeRef.current = null;
    pendingSeekRef.current = saved.time > 0 ? saved.time : null;
    orderRef.current = saved.shuffle ? { key: refKey(saved.source), ids: shuffledOrder(playlist, track.id) } : null;
    setState((current) => ({
      ...current,
      source: saved.source,
      track,
      playing: false,
      buffering: false,
      time: saved.time,
      duration: track.durationSec,
      error: null,
      shuffle: Boolean(saved.shuffle),
    }));
  }, []);

  // Load the saved spot: this device's copy right away, the synced one (other devices) when it arrives.
  useEffect(() => {
    const local = readLocalResume();
    pendingResumeRef.current = local;
    tryRestore();
    let cancelled = false;
    loadSetting("resume")
      .then((raw) => {
        const synced = parseResume(raw);
        if (cancelled || !synced || interactedRef.current || (local && local.at >= synced.at)) {
          return;
        }
        pendingResumeRef.current = synced; // newer, e.g. from listening on another device
        tryRestore();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tryRestore]);

  // Group playlists load after startup: retry whenever the playlists change.
  useEffect(() => {
    tryRestore();
  }, [resolve, tryRestore]);

  const lastLocalSave = useRef(0);
  const lastCloudSave = useRef(0);
  const saveResume = useCallback((toCloud: boolean) => {
    const { source, track, time, shuffle } = stateRef.current;
    if (!interactedRef.current) {
      return; // nothing new since the saved spot was restored (or it's still loading)
    }
    const value: ResumePoint | null =
      source && track ? { source, trackId: track.id, time: Math.floor(time), shuffle: shuffle || undefined, at: Date.now() } : null;
    writeLocalResume(value);
    lastLocalSave.current = Date.now();
    if (toCloud) {
      lastCloudSave.current = Date.now();
      void saveSetting("resume", value ? JSON.stringify(value) : "").catch(() => undefined);
    }
  }, []);

  // Save on every track/playlist/shuffle/pause change, and while playing every few seconds
  // (device) or every 20 s (synced), so closing the app at any moment loses almost nothing.
  useEffect(() => {
    saveResume(true);
  }, [state.track?.id, state.source, state.shuffle, state.playing, saveResume]);

  useEffect(() => {
    if (!state.playing) {
      return;
    }
    const now = Date.now();
    if (now - lastLocalSave.current >= 3000) {
      saveResume(now - lastCloudSave.current >= CLOUD_SAVE_EVERY_MS);
    }
  }, [state.time, state.playing, saveResume]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" || !document.visibilityState) {
        saveResume(true);
      }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [saveResume]);

  useEffect(() => {
    const audio = getAudio();
    const update = (patch: Partial<PlayerState>) => setState((current) => ({ ...current, ...patch }));

    const handlers: Record<string, () => void> = {
      play: () => update({ playing: true }),
      playing: () => update({ playing: true, buffering: false }),
      pause: () => update({ playing: false }),
      waiting: () => update({ buffering: true }),
      canplay: () => update({ buffering: false }),
      timeupdate: () => {
        if (pendingSeekRef.current === null) {
          update({ time: audio.currentTime });
        }
      },
      loadedmetadata: () => {
        if (pendingSeekRef.current !== null) {
          audio.currentTime = pendingSeekRef.current; // continue a restored track where it stopped
          pendingSeekRef.current = null;
        }
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          update({ duration: audio.duration });
        }
      },
      ended: () => step(1),
      error: () => {
        if (!audio.getAttribute("src")) {
          return;
        }
        update({
          playing: false,
          buffering: false,
          error: "stream", // translated by the UI
        });
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      audio.addEventListener(event, handler);
    }
    return () => {
      for (const [event, handler] of Object.entries(handlers)) {
        audio.removeEventListener(event, handler);
      }
    };
  }, [getAudio, step]);

  // Lock-screen / headphone controls.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !state.track) {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.track.title,
      artist: state.track.performer,
      album: state.source ? resolveRef.current(state.source)?.title : undefined,
    });
    navigator.mediaSession.setActionHandler("play", toggle);
    navigator.mediaSession.setActionHandler("pause", toggle);
    navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
    navigator.mediaSession.setActionHandler("previoustrack", previous);
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime !== undefined) {
        seek(details.seekTime);
      }
    });
  }, [state.track, state.source, toggle, step, previous, seek]);

  return {
    state,
    play,
    toggle,
    next: () => step(1),
    previous,
    seek,
    stop,
    toggleShuffle,
    playShuffled,
    firstTrack,
    clearError: () => setState((current) => ({ ...current, error: null })),
  };
}
