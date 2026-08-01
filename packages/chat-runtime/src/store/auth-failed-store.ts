import type { ConversationId } from "../protocol/types";

import { bytesToHex } from "./encoding";
import { getDurableStorage } from "./durable-storage";

/**
 * Durable key for the auth-failed flag.
 *
 * The value is a JSON-encoded `Record<string, true>` keyed by the lowercase
 * hex of the {@link ConversationId} (matching the repository's `idKey`
 * convention). The payload is plain metadata — NOT ciphertext, NOT key
 * material — so a synchronous, reload-surviving KV store is exactly what
 * the R7/F3 durability fix needs.
 */
export const AUTH_FAILED_STORAGE_KEY = "fck-chat-v1:auth-failed";

function readRecord(): Record<string, true> {
  const store = getDurableStorage();
  if (store === null) return {};
  const raw = store.getItem(AUTH_FAILED_STORAGE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[key] = true;
    }
    return out;
  } catch {
    // Corrupt or partially-written JSON: treat as empty so a bad read never
    // crashes session start. The next successful write replaces the payload.
    return {};
  }
}

function writeRecord(record: Record<string, true>): void {
  const store = getDurableStorage();
  if (store === null) return;
  try {
    store.setItem(AUTH_FAILED_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Swallow setItem failures (e.g. Safari private-mode QuotaExceededError)
    // to honor the "Never throws" contract on `markAuthFailedDurable`. A lost
    // write only means the flag will not survive a reload; the synchronous
    // in-memory cache still defends the current session.
    return;
  }
}

function keyOf(id: ConversationId): string {
  return bytesToHex(id);
}

/**
 * Persist the auth-failed flag for a conversation so it survives a reload.
 *
 * Best-effort: resolves as a no-op when no durable store has been registered
 * (the platform must call `setDurableStorage` at boot). Never throws — a
 * failed write only means the flag will not survive a process restart, and
 * the caller (the orchestrator) treats persistence as best-effort.
 */
export async function markAuthFailedDurable(id: ConversationId): Promise<void> {
  const record = readRecord();
  record[keyOf(id)] = true;
  writeRecord(record);
}

/**
 * Read the durable auth-failed flag for a conversation.
 *
 * Returns `false` when no durable store has been registered or the flag is
 * absent. This is the cross-session source of truth consulted during
 * `start()`/`join()` hydration when the in-repo read is unavailable or
 * returns a stale false.
 */
export async function getAuthFailedDurable(id: ConversationId): Promise<boolean> {
  const record = readRecord();
  return record[keyOf(id)] === true;
}
