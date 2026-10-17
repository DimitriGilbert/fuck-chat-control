import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll, vi } from "vitest";

import {
  createPakeSession,
  derivePakeConfirmationTag,
  deriveSessionKeys,
  PakeError,
  PakeErrorCode,
  pakeFinish,
  pakeOutgoingShare,
  roleToSideByte,
  sha256,
  __setWasmModuleForTests,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair, PakeWasmModule } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  PAKE_MESSAGE_BYTES,
  PAKE_PROTOCOL_ID,
  PAKE_ROLE_A,
  PAKE_ROLE_B,
  PAKE_SHARE_BYTES,
  PROTOCOL_VERSION,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { AuthMode, Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import {
  decodePakeShare,
  encodePakeShare,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/handshake-codec";

const PKG_JS = fileURLToPath(
  new URL("../../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2.js", import.meta.url),
);
const PKG_WASM = fileURLToPath(
  new URL(
    "../../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2_bg.wasm",
    import.meta.url,
  ),
);

// R1F1/R1F2: intercept the platform-split dynamic-import loader so the tests
// at the bottom of this file can drive loadWasm's fresh-init path with a
// fake SPAKE2 binding (counting init calls, injecting faults) without a real
// .wasm fetch or module URL. The mock is inert for every other test here:
// they all seed the module cache via `__setWasmModuleForTests`, so
// `dynamicImport` is never reached on the statically-imported graph.
const dynamicImportMock = vi.hoisted(() => vi.fn<(specifier: string) => Promise<unknown>>());
vi.mock("@fuck-eu-chat-control/chat-runtime/crypto/pake-loader", () => ({
  dynamicImport: (specifier: string): Promise<unknown> => dynamicImportMock(specifier),
}));

// Synchronous init: the browser path uses fetch+WebAssembly.instantiateStreaming
// via the pkg's default export, which Node cannot do. initSync seeds the same
// wasm singleton the wrapper ultimately calls through.
beforeAll(async () => {
  const wasmBytes = new Uint8Array(readFileSync(PKG_WASM));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const binding = (await import(PKG_JS)) as unknown as {
    initSync(module: { module: WebAssembly.Module }): void;
    pake_start: PakeWasmModule["pake_start"];
    pake_finish: PakeWasmModule["pake_finish"];
  };
  binding.initSync({ module: wasmModule });
  __setWasmModuleForTests(binding);
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("roleToSideByte — deterministic A/B mapping", () => {
  it("maps the session initiator to SPAKE2 side A", () => {
    expect(roleToSideByte(Role.Initiator)).toBe(PAKE_ROLE_A);
  });

  it("maps the session responder to SPAKE2 side B", () => {
    expect(roleToSideByte(Role.Responder)).toBe(PAKE_ROLE_B);
  });
});

describe("SPAKE2 cross-completion (RFC 9383, crate test_basic parity)", () => {
  it("both derived roles with the same code derive the SAME shared secret", async () => {
    const code = "123456";
    const a = await createPakeSession(code, Role.Initiator);
    const b = await createPakeSession(code, Role.Responder);
    const aShare = pakeOutgoingShare(a);
    const bShare = pakeOutgoingShare(b);
    expect(aShare.length).toBe(PAKE_SHARE_BYTES);
    expect(bShare.length).toBe(PAKE_SHARE_BYTES);
    // Side byte is the first byte of the share; A and B must differ.
    expect(aShare[0]).toBe(PAKE_ROLE_A);
    expect(bShare[0]).toBe(PAKE_ROLE_B);
    const aSecret = await pakeFinish(a, bShare);
    const bSecret = await pakeFinish(b, aShare);
    expect(aSecret.length).toBe(32);
    expect(bSecret.length).toBe(32);
    expect(bytesEqual(aSecret, bSecret)).toBe(true);
  });

  it("the two derived shares are distinct (no reflected-message equality)", async () => {
    const code = "654321";
    const a = await createPakeSession(code, Role.Initiator);
    const b = await createPakeSession(code, Role.Responder);
    expect(bytesEqual(pakeOutgoingShare(a), pakeOutgoingShare(b))).toBe(false);
  });

  it("different codes derive DIFFERENT shared secrets (wrong-password detection)", async () => {
    const a = await createPakeSession("111111", Role.Initiator);
    const b = await createPakeSession("222222", Role.Responder);
    const aShare = pakeOutgoingShare(a);
    const bShare = pakeOutgoingShare(b);
    const aSecret = await pakeFinish(a, bShare);
    const bSecret = await pakeFinish(b, aShare);
    expect(bytesEqual(aSecret, bSecret)).toBe(false);
  });

  it("reflected own share aborts with PakeError (BadSide)", async () => {
    const a = await createPakeSession("999999", Role.Initiator);
    const ownShare = pakeOutgoingShare(a);
    await expect(pakeFinish(a, ownShare)).rejects.toMatchObject({
      code: PakeErrorCode.Abort,
    });
  });

  it("a malformed (wrong length) peer share throws InvalidShare", async () => {
    const a = await createPakeSession("314159", Role.Initiator);
    const short = new Uint8Array(PAKE_SHARE_BYTES - 1);
    await expect(pakeFinish(a, short)).rejects.toMatchObject({
      code: PakeErrorCode.InvalidShare,
    });
  });

  it("a corrupt peer point (wrong side byte) throws Abort", async () => {
    const a = await createPakeSession("271828", Role.Initiator);
    const b = await createPakeSession("271828", Role.Responder);
    const tampered = new Uint8Array(pakeOutgoingShare(b));
    // Flip the side byte to 'A' so the crate sees a reflected-message attack.
    tampered[0] = PAKE_ROLE_A;
    await expect(pakeFinish(a, tampered)).rejects.toMatchObject({
      code: PakeErrorCode.Abort,
    });
  });

  it("calling pakeFinish twice rejects on the second call", async () => {
    const a = await createPakeSession("000000", Role.Initiator);
    const b = await createPakeSession("000000", Role.Responder);
    await pakeFinish(a, pakeOutgoingShare(b));
    await expect(pakeFinish(a, pakeOutgoingShare(b))).rejects.toMatchObject({
      code: PakeErrorCode.Abort,
    });
  });
});

describe("deriveSessionKeys pakeSecret binding (HKDF key schedule)", () => {
  // Reuse the session-test helper style: build a deterministic transcript and
  // feed two different pakeSecrets; the traffic keys MUST differ.
  async function makeIdentity(): Promise<IdentityKeyPair> {
    const { generateIdentityKeyPair } = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    return generateIdentityKeyPair();
  }

  it("a null pakeSecret under a Pake transcript throws (no silent fallback)", async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const { buildCanonicalTranscript } = await import("./_helpers");
    const { conversationId, sessionId } = await import("./_helpers");
    const { generateEphemeralKeyPair } = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const ephA = await generateEphemeralKeyPair();
    const ephB = await generateEphemeralKeyPair();
    const transcript = buildCanonicalTranscript(
      conversationId(1),
      {
        identityPublicKey: a.publicKey,
        ecdhPublicKey: ephA.publicKey,
        sessionId: sessionId(1),
      },
      {
        identityPublicKey: b.publicKey,
        ecdhPublicKey: ephB.publicKey,
        sessionId: sessionId(2),
      },
    );
    // Force authMode to Pake on the transcript to exercise the defensive path.
    const pakeTranscript = { ...transcript, authMode: AuthMode.Pake };
    await expect(
      deriveSessionKeys({
        localEcdhPrivateKey: ephA.privateKey,
        peerEcdhPublicKey: ephB.publicKey,
        transcript: pakeTranscript,
        localIdentityPublicKey: a.publicKey,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("a real pakeSecret produces keys distinct from the SafetyNumberOnly schedule", async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const { buildCanonicalTranscript } = await import("./_helpers");
    const { conversationId, sessionId } = await import("./_helpers");
    const { generateEphemeralKeyPair } = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const ephA = await generateEphemeralKeyPair();
    const ephB = await generateEphemeralKeyPair();
    const transcriptBase = buildCanonicalTranscript(
      conversationId(1),
      {
        identityPublicKey: a.publicKey,
        ecdhPublicKey: ephA.publicKey,
        sessionId: sessionId(1),
      },
      {
        identityPublicKey: b.publicKey,
        ecdhPublicKey: ephB.publicKey,
        sessionId: sessionId(2),
      },
    );
    const snKeys = await deriveSessionKeys({
      localEcdhPrivateKey: ephA.privateKey,
      peerEcdhPublicKey: ephB.publicKey,
      transcript: transcriptBase,
      localIdentityPublicKey: a.publicKey,
    });
    const fakePakeSecret = new Uint8Array(32).fill(0xab);
    const pakeTranscript = { ...transcriptBase, authMode: AuthMode.Pake };
    const pakeKeys = await deriveSessionKeys({
      localEcdhPrivateKey: ephA.privateKey,
      peerEcdhPublicKey: ephB.publicKey,
      transcript: pakeTranscript,
      localIdentityPublicKey: a.publicKey,
      pakeSecret: fakePakeSecret,
    });
    expect(bytesEqual(snKeys.sendKey, pakeKeys.sendKey)).toBe(false);
    expect(bytesEqual(snKeys.recvKey, pakeKeys.recvKey)).toBe(false);
  });

  it("two different pakeSecrets produce different traffic keys", async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const { buildCanonicalTranscript } = await import("./_helpers");
    const { conversationId, sessionId } = await import("./_helpers");
    const { generateEphemeralKeyPair } = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const ephA = await generateEphemeralKeyPair();
    const ephB = await generateEphemeralKeyPair();
    const transcriptBase = buildCanonicalTranscript(
      conversationId(1),
      {
        identityPublicKey: a.publicKey,
        ecdhPublicKey: ephA.publicKey,
        sessionId: sessionId(1),
      },
      {
        identityPublicKey: b.publicKey,
        ecdhPublicKey: ephB.publicKey,
        sessionId: sessionId(2),
      },
    );
    const pakeTranscript = { ...transcriptBase, authMode: AuthMode.Pake };
    const s1 = new Uint8Array(32).fill(0x11);
    const s2 = new Uint8Array(32).fill(0x22);
    const k1 = await deriveSessionKeys({
      localEcdhPrivateKey: ephA.privateKey,
      peerEcdhPublicKey: ephB.publicKey,
      transcript: pakeTranscript,
      localIdentityPublicKey: a.publicKey,
      pakeSecret: s1,
    });
    const k2 = await deriveSessionKeys({
      localEcdhPrivateKey: ephA.privateKey,
      peerEcdhPublicKey: ephB.publicKey,
      transcript: pakeTranscript,
      localIdentityPublicKey: a.publicKey,
      pakeSecret: s2,
    });
    expect(bytesEqual(k1.sendKey, k2.sendKey)).toBe(false);
  });
});

describe("PakeShare wire codec (handshake-codec.ts)", () => {
  it("round-trips a 33-byte share for side A", () => {
    const share = new Uint8Array(PAKE_SHARE_BYTES);
    for (let i = 0; i < PAKE_SHARE_BYTES; i++) share[i] = (i * 7 + 1) & 0xff;
    const wire = encodePakeShare(PAKE_ROLE_A, share);
    expect(wire.length).toBe(PAKE_MESSAGE_BYTES);
    expect(wire[0]).toBe(PROTOCOL_VERSION);
    const decoded = decodePakeShare(wire);
    expect(decoded.role).toBe(PAKE_ROLE_A);
    expect(bytesEqual(decoded.share, share)).toBe(true);
  });

  it("rejects an invalid role byte", () => {
    const share = new Uint8Array(PAKE_SHARE_BYTES);
    expect(() => encodePakeShare(0x00, share)).toThrow(/PakeShare role/);
    expect(() => encodePakeShare(0x5a, share)).toThrow(/PakeShare role/);
  });

  it("rejects a wrong-length share on encode", () => {
    expect(() => encodePakeShare(PAKE_ROLE_B, new Uint8Array(PAKE_SHARE_BYTES - 1))).toThrow(
      /PakeShare payload/,
    );
  });

  it("rejects a wrong-length message on decode", () => {
    expect(() => decodePakeShare(new Uint8Array(PAKE_MESSAGE_BYTES - 1))).toThrow(
      /PakeShareMessage/,
    );
  });
});

describe("createPakeSession error paths", () => {
  it("rejects an empty code", async () => {
    await expect(createPakeSession("", Role.Initiator)).rejects.toMatchObject({
      code: PakeErrorCode.InvalidShare,
    });
  });

  it("exposes a PakeError with the expected shape", async () => {
    try {
      await createPakeSession("", Role.Initiator);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PakeError);
      const e = err as PakeError;
      expect(e.code).toBe(PakeErrorCode.InvalidShare);
      expect(e.name).toBe("PakeError");
      expect(e.message).toContain(PakeErrorCode.InvalidShare);
    }
  });
});

describe("AuthMode plumbing — Pake (0x02) is a first-class value", () => {
  it("AuthMode.Pake exists and is distinct from SafetyNumberOnly", () => {
    expect(AuthMode.Pake).toBe(0x02);
    expect(AuthMode.Pake).not.toBe(AuthMode.SafetyNumberOnly);
  });

  it("the protocol id is the locked ASCII domain-separation tag", () => {
    expect(PAKE_PROTOCOL_ID).toBe("fuck-eu-chat-control/v1");
  });
});

describe("derivePakeConfirmationTag (wrong-code abort primitive)", () => {
  it("two peers with the SAME pakeSecret derive matching directional tags", async () => {
    const transcriptHash = await sha256(new TextEncoder().encode("transcript"));
    const secret = new Uint8Array(32).fill(0x42);
    const initiatorTag = await derivePakeConfirmationTag(secret, transcriptHash, Role.Initiator);
    const responderTag = await derivePakeConfirmationTag(secret, transcriptHash, Role.Responder);
    expect(initiatorTag.length).toBe(32);
    // The initiator's tag and the responder's tag are role-bound and differ.
    expect(bytesEqual(initiatorTag, responderTag)).toBe(false);
    // But each side's tag for ITS OWN role matches what the peer computes for
    // the SAME role — i.e. the tag is a pure function of (secret, hash, role).
    const initiatorTagAgain = await derivePakeConfirmationTag(
      secret,
      transcriptHash,
      Role.Initiator,
    );
    expect(bytesEqual(initiatorTag, initiatorTagAgain)).toBe(true);
  });

  it("two peers with DIFFERENT pakeSecrets derive different tags (mismatch)", async () => {
    const transcriptHash = await sha256(new TextEncoder().encode("transcript"));
    const s1 = new Uint8Array(32).fill(0x01);
    const s2 = new Uint8Array(32).fill(0x02);
    const tag1 = await derivePakeConfirmationTag(s1, transcriptHash, Role.Initiator);
    const tag2 = await derivePakeConfirmationTag(s2, transcriptHash, Role.Initiator);
    expect(bytesEqual(tag1, tag2)).toBe(false);
  });

  it("the tag binds to the transcript hash (different hashes → different tags)", async () => {
    const secret = new Uint8Array(32).fill(0x99);
    const h1 = await sha256(new TextEncoder().encode("one"));
    const h2 = await sha256(new TextEncoder().encode("two"));
    const t1 = await derivePakeConfirmationTag(secret, h1, Role.Initiator);
    const t2 = await derivePakeConfirmationTag(secret, h2, Role.Initiator);
    expect(bytesEqual(t1, t2)).toBe(false);
  });
});

/**
 * A fake SPAKE2 binding returned by the mocked `dynamicImport`. `pake_start`
 * yields a structurally valid {@link PakeStateHandle} (33-byte share + free);
 * `default` plays the async init — it can be told to throw for its first N
 * invocations and deliberately parks for a few ms so that a second caller
 * racing in mid-init would trigger a second import under the old post-await
 * assignment.
 */
function fakeSpake2Module(opts: { failInitTimes?: number; finishError?: unknown } = {}): {
  module: unknown;
  initCalls: () => number;
} {
  let initCalls = 0;
  const module = {
    default: async (): Promise<void> => {
      initCalls++;
      if (opts.failInitTimes !== undefined && initCalls <= opts.failInitTimes) {
        throw new Error("fake spake2 init failure");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    initSync: (): void => {},
    pake_start: (role: number): { side: number; outgoing_share: Uint8Array; free(): void } => ({
      side: role,
      outgoing_share: new Uint8Array(PAKE_SHARE_BYTES),
      free(): void {},
    }),
    pake_finish: (): Uint8Array => {
      if (opts.finishError !== undefined) {
        throw opts.finishError;
      }
      return new Uint8Array(32);
    },
  };
  return { module, initCalls: () => initCalls };
}

describe("loadWasm single-flight & init retry (R1F1)", () => {
  it("concurrent createPakeSession calls share ONE wasm init", async () => {
    vi.resetModules();
    dynamicImportMock.mockReset();
    const fake = fakeSpake2Module();
    dynamicImportMock.mockImplementation(async () => fake.module);
    // A fresh module graph: its `wasmModulePromise` starts null so the real
    // loadWasm path (mocked loader, real single-flight logic) is exercised.
    const crypto = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const [a, b, c] = await Promise.all([
      crypto.createPakeSession("123456", Role.Initiator),
      crypto.createPakeSession("654321", Role.Responder),
      crypto.createPakeSession("111111", Role.Initiator),
    ]);
    expect(a.state).not.toBeNull();
    expect(b.state).not.toBeNull();
    expect(c.state).not.toBeNull();
    expect(fake.initCalls()).toBe(1);
    expect(dynamicImportMock).toHaveBeenCalledTimes(1);
    expect(dynamicImportMock).toHaveBeenCalledWith("../../wasm/spake2/pkg/fck_spake2.js");
  });

  it("a failed init is not cached: concurrent callers share the rejection and the next call retries", async () => {
    vi.resetModules();
    dynamicImportMock.mockReset();
    const fake = fakeSpake2Module({ failInitTimes: 1 });
    dynamicImportMock.mockImplementation(async () => fake.module);
    const crypto = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const [r1, r2] = await Promise.allSettled([
      crypto.createPakeSession("123456", Role.Initiator),
      crypto.createPakeSession("123456", Role.Responder),
    ]);
    // Both callers observe the SAME rejection from the shared init.
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    if (r1.status === "rejected" && r2.status === "rejected") {
      expect(r1.reason).toBe(r2.reason);
      expect((r1.reason as Error).message).toContain("fake spake2 init failure");
    }
    expect(fake.initCalls()).toBe(1);
    // The rejection cleared the slot: the next call re-imports and succeeds
    // (retry-after-failed-init semantics preserved).
    const session = await crypto.createPakeSession("123456", Role.Initiator);
    expect(session.state).not.toBeNull();
    expect(fake.initCalls()).toBe(2);
    expect(dynamicImportMock).toHaveBeenCalledTimes(2);
  });
});

describe("mapWasmError classification (R1F2)", () => {
  it("rethrows an unrecognized wasm error UNTYPED so it is not durable-auth-classified", async () => {
    vi.resetModules();
    dynamicImportMock.mockReset();
    const infraFault = new Error("unreachable: null pointer passed to wasm");
    const fake = fakeSpake2Module({ finishError: infraFault });
    dynamicImportMock.mockImplementation(async () => fake.module);
    const crypto = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const session = await crypto.createPakeSession("123456", Role.Initiator);
    let thrown: unknown;
    try {
      await crypto.pakeFinish(session, new Uint8Array(PAKE_SHARE_BYTES));
    } catch (err) {
      thrown = err;
    }
    // The original fault propagates unchanged — crucially NOT as a PakeError.
    // The orchestrator's isAuthFailureError only classifies `instanceof
    // PakeError` (minus Cancelled/Timeout) as durable, so an untyped rethrow
    // cannot brick the conversation over an infrastructure fault.
    expect(thrown).toBe(infraFault);
    expect(thrown).not.toBeInstanceOf(PakeError);
    expect((thrown as Error).name).not.toBe("PakeError");
  });

  it("a non-Error wasm throw is wrapped in a plain Error (still untyped)", async () => {
    vi.resetModules();
    dynamicImportMock.mockReset();
    const fake = fakeSpake2Module({ finishError: "string fault" });
    dynamicImportMock.mockImplementation(async () => fake.module);
    const crypto = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const session = await crypto.createPakeSession("123456", Role.Initiator);
    let thrown: unknown;
    try {
      await crypto.pakeFinish(session, new Uint8Array(PAKE_SHARE_BYTES));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PakeError);
    expect((thrown as Error).message).toContain("string fault");
  });

  it("still maps recognized spake2::Error names to typed PakeError codes", async () => {
    vi.resetModules();
    dynamicImportMock.mockReset();
    const fake = fakeSpake2Module({ finishError: new Error("pake_finish: CorruptMessage") });
    dynamicImportMock.mockImplementation(async () => fake.module);
    const crypto = await import("@fuck-eu-chat-control/chat-runtime/crypto");
    const session = await crypto.createPakeSession("123456", Role.Initiator);
    await expect(
      crypto.pakeFinish(session, new Uint8Array(PAKE_SHARE_BYTES)),
    ).rejects.toMatchObject({
      name: "PakeError",
      code: PakeErrorCode.InvalidShare,
    });
  });
});
