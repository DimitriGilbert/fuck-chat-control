import { describe, expect, it } from "vitest";

import { deriveNonce } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  ProtocolError,
  ProtocolErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/protocol/errors";
import {
  GCM_NONCE_BYTES,
  SESSION_ID_BYTES,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { SessionId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

function sessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed + i) & 0xff;
  return bytes as unknown as SessionId;
}

describe("deriveNonce (session-id-prefix XOR sequence)", () => {
  it("produces a 96-bit nonce equal to session_id[0..12] for sequence 0", () => {
    const sid = sessionId(0);
    const nonce = deriveNonce(sid, 0);
    expect(nonce.length).toBe(GCM_NONCE_BYTES);
    expect(Array.from(nonce)).toEqual(Array.from(sid.subarray(0, GCM_NONCE_BYTES)));
  });

  it("XORs the trailing 4 bytes with the big-endian uint32 sequence", () => {
    const sid = sessionId(0);
    const base = sid.subarray(0, GCM_NONCE_BYTES);
    const nonce = deriveNonce(sid, 0x01020304);
    expect(nonce[8]).toBe(base[8] ^ 0x01);
    expect(nonce[9]).toBe(base[9] ^ 0x02);
    expect(nonce[10]).toBe(base[10] ^ 0x03);
    expect(nonce[11]).toBe(base[11] ^ 0x04);
  });

  it("produces distinct nonces for distinct sequences under one session id", () => {
    const sid = sessionId(0);
    const a = deriveNonce(sid, 1);
    const b = deriveNonce(sid, 2);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("produces distinct nonces for the same sequence under distinct session ids", () => {
    const n1 = deriveNonce(sessionId(0), 5);
    const n2 = deriveNonce(sessionId(1), 5);
    expect(Array.from(n1)).not.toEqual(Array.from(n2));
  });

  it("accepts the maximum uint32 sequence", () => {
    const sid = sessionId(0);
    const nonce = deriveNonce(sid, 0xffffffff);
    expect(nonce[8]).toBe(sid[8] ^ 0xff);
    expect(nonce[11]).toBe(sid[11] ^ 0xff);
  });

  it("rejects a negative sequence", () => {
    try {
      deriveNonce(sessionId(0), -1);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidRange);
    }
  });

  it("rejects a sequence that overflows uint32", () => {
    try {
      deriveNonce(sessionId(0), 0x100000000);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.InvalidRange);
    }
  });
});
