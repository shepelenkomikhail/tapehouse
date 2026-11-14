import { useCallback, useEffect, useRef, useState } from "react";
import type { Playlist, Track } from "../../shared/types";
import { streamUrl } from "../lib/api";

export type PlaylistRef =
  | { kind: "personal"; playlistId: string }
  | { kind: "group"; chatId: string; playlistId: string };

export function sameRef(a: PlaylistRef | null, b: PlaylistRef | null) {
  return (
    !!a &&
    !!b &&
    a.kind === b.kind &&
    a.playlistId === b.playlistId &&
    (a.kind === "personal" || a.chatId === (b as { chatId: string }).chatId)
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
}

/**
 * Plays a playlist with a single <audio> element. The queue is always the *current* order of the
 * source playlist, so reordering or shuffling while listening changes what plays next.
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
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    return audioRef.current;
  }, []);

  const play = useCallback(
    (source: PlaylistRef, track: Track) => {
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
      const index = playlist.tracks.findIndex((item) => item.id === track.id);
      const next = playlist.tracks[index + offset];
      if (next) {
        play(source, next);
      } else if (offset === 1) {
        getAudio().pause();
      }
    },
    [getAudio, play],
  );

  const toggle = useCallback(() => {
    const audio = getAudio();
    if (!stateRef.current.track) {
      return;
    }
    if (audio.paused) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, [getAudio]);

  const previous = useCallback(() => {
    const audio = getAudio();
    if (audio.currentTime > 4) {
      audio.currentTime = 0;
    } else {
      step(-1);
    }
  }, [getAudio, step]);

  const seek = useCallback(
    (seconds: number) => {
      const audio = getAudio();
      audio.currentTime = seconds;
      setState((current) => ({ ...current, time: seconds }));
    },
    [getAudio],
  );

  const stop = useCallback(() => {
    const audio = getAudio();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    setState((current) => ({ ...current, source: null, track: null, playing: false, time: 0 }));
  }, [getAudio]);

  useEffect(() => {
    const audio = getAudio();
    const update = (patch: Partial<PlayerState>) => setState((current) => ({ ...current, ...patch }));

    const handlers: Record<string, () => void> = {
      play: () => update({ playing: true }),
      playing: () => update({ playing: true, buffering: false }),
      pause: () => update({ playing: false }),
      waiting: () => update({ buffering: true }),
      canplay: () => update({ buffering: false }),
      timeupdate: () => update({ time: audio.currentTime }),
      loadedmetadata: () => {
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
    clearError: () => setState((current) => ({ ...current, error: null })),
  };
}
