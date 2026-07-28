import { p256 } from "@noble/curves/p256";

import {
  encodeConversationId,
  encodePublicKey,
} from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationId, PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

export { bytesEqual } from "../crypto/_helpers";

export function conversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

export function deterministicPublicKey(seed: number): PublicKey {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 7 + i + 1) & 0xff;
  return encodePublicKey(p256.getPublicKey(sk, false));
}

export function fingerprintOf(publicKey: PublicKey, seed: number): string {
  let hex = "";
  for (let i = 0; i < publicKey.length; i++) {
    hex += ((publicKey[i] ^ seed) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Minimal in-memory `Storage` implementation for unit tests that exercise
 * `localStorage`-backed modules. The Node test environment has no `localStorage`
 * global, so tests that need it install an instance on `globalThis` (and remove
 * it for the SSR-absence case). This implements just the `getItem`/`setItem`/
 * `removeItem`/`clear` surface the store touches plus the `key`/`length`
 * members the `Storage` type requires.
 */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    if (index < 0 || index >= this.map.size) return null;
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}
