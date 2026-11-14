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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function callOnce<T>(label: string, call: (callback: (error: string | null, result?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    // Some Telegram clients never answer a failed request; don't hang forever.
    const timer = setTimeout(() => reject(new Error(`CloudStorage ${label}: no response`)), 10_000);
    try {
      call((error, result) => {
        clearTimeout(timer);
        if (error) {
          reject(new Error(`CloudStorage ${label}: ${error}`));
        } else {
          resolve(result as T);
        }
      });
    } catch (error) {
      clearTimeout(timer);
      reject(new Error(`CloudStorage ${label}: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

/**
 * Telegram clients handle CloudStorage requests unreliably when many are in flight at once,
 * so every request goes through one queue, and failed ones are retried with backoff.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(label: string, call: (callback: (error: string | null, result?: T) => void) => void) {
  const run = chain.then(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await sleep(400 * attempt);
      }
      try {
        return await callOnce(label, call);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  });
  chain = run.catch(() => undefined);
  return run;
}

function telegramKeyValue(storage: TelegramCloudStorage): KeyValue {
  return {
    async get(keys) {
      const result: Record<string, string> = {};
      for (let i = 0; i < keys.length; i += 50) {
        Object.assign(
          result,
          await serial<Record<string, string>>("getItems", (cb) => storage.getItems(keys.slice(i, i + 50), cb)),
        );
      }
      return result;
    },
    set: (key, value) => serial<boolean>(`setItem(${key})`, (cb) => storage.setItem(key, value, cb)).then(() => undefined),
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 50) {
        await serial<boolean>("removeItems", (cb) => storage.removeItems(keys.slice(i, i + 50), cb));
      }
    },
    keys: () => serial<string[]>("getKeys", (cb) => storage.getKeys(cb)),
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

/**
 * Values are capped at 4096; Telegram may count UTF-8 bytes rather than characters, and
 * Cyrillic takes 2 bytes per letter, so chunks are sized by bytes with a safety margin.
 */
const CHUNK_BYTES = 3000;

/** Splits text into chunks by UTF-8 size, never cutting a character (or emoji) in half. */
function chunk(text: string) {
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > CHUNK_BYTES) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts;
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
  for (const [i, part] of parts.entries()) {
    await kv.set(chunkKey(name, generation, i), part);
  }
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

/** Documents we know don't exist yet (e.g. a just-created playlist) skip the header lookup. */
export function markNewDoc(name: string) {
  if (!headers.has(name)) {
    headers.set(name, null);
  }
}

/** Small standalone settings (e.g. UI language) that live outside the document scheme. */
export const SETTING_KEYS = ["lang"] as const;
export async function loadSetting(key: (typeof SETTING_KEYS)[number]) {
  return (await kv.get([key]))[key] || null;
}
export function saveSetting(key: (typeof SETTING_KEYS)[number], value: string) {
  return kv.set(key, value);
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
    const live = new Set<string>(SETTING_KEYS);
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
