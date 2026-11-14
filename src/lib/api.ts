import type { GroupLibrary, InboxResponse, PlaylistOp, Track } from "../../shared/types";
import { getWebApp } from "./telegram";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  const initData = getWebApp()?.initData;
  if (initData) {
    headers.authorization = `tma ${initData}`; // every call proves who the Telegram user is
  }
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status}).`, payload.code);
  }
  return payload;
}

export const api = {
  getInbox: () => request<InboxResponse>("/api/inbox"),
  ackInbox: (trackIds: string[]) =>
    request<{ remaining: number }>("/api/inbox", { method: "POST", body: { trackIds } }),
  getGroup: (chatId: string) => request<GroupLibrary>(`/api/group?chat=${encodeURIComponent(chatId)}`),
  groupOp: (chatId: string, op: PlaylistOp) =>
    request<GroupLibrary>(`/api/group?chat=${encodeURIComponent(chatId)}`, { method: "POST", body: op }),
  report: (event: string, detail: string, client: Record<string, string | number | boolean | null>) =>
    request<{ ok: boolean }>("/api/log", { method: "POST", body: { event, detail: detail.slice(0, 2000), client } }),
  sendToChat: (title: string, tracks: Track[]) =>
    request<{ sent: number }>("/api/send", {
      method: "POST",
      body: { title, tracks: tracks.map(({ fileId, sig, kind }) => ({ fileId, sig, kind })) },
    }),
};

export function streamUrl(track: Track) {
  return `/api/stream?f=${encodeURIComponent(track.fileId)}&s=${encodeURIComponent(track.sig)}`;
}
