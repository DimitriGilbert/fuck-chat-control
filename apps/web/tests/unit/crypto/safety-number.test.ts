import { describe, expect, it } from "vitest";

import { computeSafetyNumber } from "@/features/chat/crypto";
import type { ConversationId, PublicKey } from "@/features/chat/protocol/types";

import {
  buildCanonicalTranscript,
  compareBytes,
  conversationId,
  deterministicPublicKey,
  sessionId,
} from "./_helpers";

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function uint40Be(bytes: Uint8Array): number {
  return (
    bytes[0] * 0x100000000 + bytes[1] * 0x1000000 + bytes[2] * 0x10000 + bytes[3] * 0x100 + bytes[4]
  );
}

async function independentSafetyNumber(
  conv: ConversationId,
  a: PublicKey,
  b: PublicKey,
): Promise<string> {
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const material = concat(conv, first, second);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
  const value = uint40Be(digest.subarray(0, 5)) % 10 ** 12;
  const padded = value.toString(10).padStart(12, "0");
  const groups: string[] = [];
  for (let i = 0; i < padded.length; i += 2) groups.push(padded.slice(i, i + 2));
  return groups.join(" ");
}

describe("computeSafetyNumber (Truncate(SHA-256, 40 bits) base10, PRD §Cryptographic design)", () => {
  it("matches an independent computation of Base10(Trunc(SHA-256(conv||sort(idA,idB)),40))", async () => {
    const conv = conversationId(5);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const expected = await independentSafetyNumber(conv, a, b);
    const actual = await computeSafetyNumber(conv, a, b);
    expect(actual).toBe(expected);
  });

  it("is symmetric in A/B (order of arguments does not matter)", async () => {
    const conv = conversationId(5);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const ab = await computeSafetyNumber(conv, a, b);
    const ba = await computeSafetyNumber(conv, b, a);
    expect(ab).toBe(ba);
  });

  it("is stable across recomputation (resumptions)", async () => {
    const conv = conversationId(5);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const first = await computeSafetyNumber(conv, a, b);
    const second = await computeSafetyNumber(conv, a, b);
    expect(first).toBe(second);
  });

  it("changes when either identity key changes", async () => {
    const conv = conversationId(5);
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const c = deterministicPublicKey(3);
    const ab = await computeSafetyNumber(conv, a, b);
    const cb = await computeSafetyNumber(conv, c, b);
    const ac = await computeSafetyNumber(conv, a, c);
    expect(ab).not.toBe(cb);
    expect(ab).not.toBe(ac);
  });

  it("changes when the conversation id changes", async () => {
    const a = deterministicPublicKey(1);
    const b = deterministicPublicKey(2);
    const n1 = await computeSafetyNumber(conversationId(5), a, b);
    const n2 = await computeSafetyNumber(conversationId(6), a, b);
    expect(n1).not.toBe(n2);
  });

  it("differs for two distinct identity pairs in the same conversation", async () => {
    const conv = conversationId(5);
    const ab = await computeSafetyNumber(
      conv,
      deterministicPublicKey(1),
      deterministicPublicKey(2),
    );
    const cd = await computeSafetyNumber(
      conv,
      deterministicPublicKey(3),
      deterministicPublicKey(4),
    );
    expect(ab).not.toBe(cd);
  });

  it("renders as space-separated groups of at most two decimal digits", async () => {
    const conv = conversationId(5);
    const n = await computeSafetyNumber(conv, deterministicPublicKey(1), deterministicPublicKey(2));
    expect(n.length).toBeGreaterThan(0);
    const tokens = n.split(" ");
    for (const token of tokens) {
      expect(token).toMatch(/^\d{1,2}$/);
    }
    expect(tokens.join("").replace(/^0+/, "")).toMatch(/^\d{1,13}$/);
  });

  it("matches the value derived through the canonical transcript identity ordering", async () => {
    const conv = conversationId(8);
    const a = deterministicPublicKey(11);
    const b = deterministicPublicKey(22);
    const transcript = buildCanonicalTranscript(
      conv,
      {
        identityPublicKey: a,
        ecdhPublicKey: deterministicPublicKey(100),
        sessionId: sessionId(200),
      },
      {
        identityPublicKey: b,
        ecdhPublicKey: deterministicPublicKey(101),
        sessionId: sessionId(201),
      },
    );
    const fromTranscript = await computeSafetyNumber(
      conv,
      transcript.initiatorIdentityKey,
      transcript.responderIdentityKey,
    );
    const direct = await computeSafetyNumber(conv, a, b);
    expect(fromTranscript).toBe(direct);
  });
});
