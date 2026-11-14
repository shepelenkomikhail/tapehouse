import { getWebApp, hasCloudStorage, type TelegramCloudStorage } from "./telegram";

/**
 * Key-value storage backed by Telegram CloudStorage (synced to the user's Telegram account,
 * across all their devices). Outside Telegram it falls back to localStorage for previews.
 *
 * CloudStorage limits: keys 1-128 chars of [A-Za-z0-9_-], values up to 4096 chars,
 * 1024 keys per user. Documents larger than one value are split into chunks.
 */

interface KeyValue {
  get(keys: string[]): Promise<Record<string, string>>;
  set(key: string, value: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(): Promise<string[]>;
}

function promisify<T>(call: (callback: (error: string | null, result?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    call((error, result) => (error ? reject(new Error(`CloudStorage: ${error}`)) : resolve(result as T)));
  });
}

function telegramKeyValue(storage: TelegramCloudStorage): KeyValue {
  return {
    async get(keys) {
      const result: Record<string, string> = {};
      for (let i = 0; i < keys.length; i += 50) {
        Object.assign(result, await promisify<Record<string, string>>((cb) => storage.getItems(keys.slice(i, i + 50), cb)));
      }
      return result;
    },
    set: (key, value) => promisify<boolean>((cb) => storage.setItem(key, value, cb)).then(() => undefined),
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 50) {
        await promisify<boolean>((cb) => storage.removeItems(keys.slice(i, i + 50), cb));
      }
    },
    keys: () => promisify<string[]>((cb) => storage.getKeys(cb)),
  };
}

const LOCAL_PREFIX = "tapehouse:";
const localKeyValue: KeyValue = {
  async get(keys) {
    const result: Record<string, string> = {};
    for (const key of keys) {
      result[key] = localStorage.getItem(LOCAL_PREFIX + key) ?? "";
    }
    return result;
  },
  async set(key, value) {
    localStorage.setItem(LOCAL_PREFIX + key, value);
  },
  async remove(keys) {
    keys.forEach((key) => localStorage.removeItem(LOCAL_PREFIX + key));
  },
  async keys() {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(LOCAL_PREFIX))
      .map((key) => key.slice(LOCAL_PREFIX.length));
  },
};

const kv: KeyValue = hasCloudStorage() ? telegramKeyValue(getWebApp()!.CloudStorage) : localKeyValue;

export const isSyncedStorage = hasCloudStorage();

const CHUNK_SIZE = 4000;

/** Splits text into chunks without cutting a surrogate pair (emoji) in half. */
function chunk(text: string) {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts.length > 0 ? parts : [""];
}

/**
 * Header key `name` holds "<generation>:<chunkCount>"; chunks live at `name__<gen>_<i>`.
 * A save writes the new generation first and only then flips the header, so an interrupted
 * save leaves the previous version readable.
 */
function chunkKey(name: string, generation: number, index: number) {
  return `${name}__${generation}_${index}`;
}

function parseHeader(value: string | undefined) {
  const match = /^(\d+):(\d+)$/.exec(value ?? "");
  return match ? { generation: Number(match[1]), count: Number(match[2]) } : null;
}

const headers = new Map<string, { generation: number; count: number } | null>();

export async function loadDocs<T>(names: string[]): Promise<Record<string, T | null>> {
  const headerValues = await kv.get(names);
  const wanted: string[] = [];
  for (const name of names) {
    const header = parseHeader(headerValues[name]);
    headers.set(name, header);
    if (header) {
      for (let i = 0; i < header.count; i += 1) {
        wanted.push(chunkKey(name, header.generation, i));
      }
    }
  }

  const chunks = wanted.length > 0 ? await kv.get(wanted) : {};
  const result: Record<string, T | null> = {};
  for (const name of names) {
    const header = headers.get(name);
    if (!header) {
      result[name] = null;
      continue;
    }
    let text = "";
    for (let i = 0; i < header.count; i += 1) {
      text += chunks[chunkKey(name, header.generation, i)] ?? "";
    }
    try {
      result[name] = JSON.parse(text) as T;
    } catch {
      console.warn(`Tapehouse: document ${name} is unreadable`);
      result[name] = null;
    }
  }
  return result;
}

// Saves to the same document are chained, and only the newest pending value is written.
const queues = new Map<string, Promise<void>>();
const pending = new Map<string, { value: unknown } | { deleted: true }>();

async function writeDoc(name: string) {
  const next = pending.get(name);
  pending.delete(name);
  if (!next) {
    return;
  }

  if (!headers.has(name)) {
    headers.set(name, parseHeader((await kv.get([name]))[name]));
  }
  const previous = headers.get(name) ?? null;
  const staleKeys = previous
    ? Array.from({ length: previous.count }, (_, i) => chunkKey(name, previous.generation, i))
    : [];

  if ("deleted" in next) {
    await kv.remove([name, ...staleKeys]);
    headers.set(name, null);
    return;
  }

  const generation = previous ? (previous.generation + 1) % 1000 : 0;
  const parts = chunk(JSON.stringify(next.value));
  await Promise.all(parts.map((part, i) => kv.set(chunkKey(name, generation, i), part)));
  await kv.set(name, `${generation}:${parts.length}`);
  headers.set(name, { generation, count: parts.length });
  if (staleKeys.length > 0) {
    await kv.remove(staleKeys).catch(() => undefined); // leftovers are cleaned by collectGarbage()
  }
}

let inFlight = 0;

function enqueue(name: string) {
  const run = (queues.get(name) ?? Promise.resolve()).then(async () => {
    inFlight += 1;
    try {
      await writeDoc(name);
    } finally {
      inFlight -= 1;
    }
  });
  const tracked = run.catch((error) => {
    console.error(error);
    throw error;
  });
  queues.set(name, tracked.catch(() => undefined));
  return tracked;
}

export function saveDoc(name: string, value: unknown) {
  pending.set(name, { value });
  return enqueue(name);
}

export function deleteDoc(name: string) {
  pending.set(name, { deleted: true });
  return enqueue(name);
}

/** Removes chunk keys that no current document header points at (e.g. from interrupted saves). */
export async function collectGarbage(liveDocNames: string[]) {
  const liveKeys = () => {
    const live = new Set<string>();
    for (const name of liveDocNames) {
      live.add(name);
      const header = headers.get(name);
      for (let i = 0; header && i < header.count; i += 1) {
        live.add(chunkKey(name, header.generation, i));
      }
    }
    return live;
  };

  const all = await kv.keys();
  // Re-check right before deleting: a save may have finished (or started) meanwhile.
  if (inFlight > 0 || pending.size > 0) {
    return;
  }
  const live = liveKeys();
  const orphans = all.filter((key) => !live.has(key));
  if (orphans.length > 0) {
    await kv.remove(orphans);
  }
}
