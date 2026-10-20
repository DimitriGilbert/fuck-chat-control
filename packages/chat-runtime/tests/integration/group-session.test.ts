import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  __setWasmModuleForTests,
  generateAtRestKey,
  generateIdentityKeyPair,
  PakeError,
  PakeErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair, PakeWasmModule } from "@fuck-eu-chat-control/chat-runtime/crypto";
import {
  encodeGroupId,
  encodePeerId,
  GroupErrorCode,
  GroupSession,
} from "@fuck-eu-chat-control/chat-runtime/group";
import type { GroupId, PeerId } from "@fuck-eu-chat-control/chat-runtime/group";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import { bytesEqual } from "../unit/crypto/_helpers";
import { linkLoopbackPair } from "../unit/orchestrator/_helpers";

const PKG_JS = fileURLToPath(
  new URL("../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2.js", import.meta.url),
);
const PKG_WASM = fileURLToPath(
  new URL("../../../../packages/chat-runtime/wasm/spake2/pkg/fck_spake2_bg.wasm", import.meta.url),
);

// Synchronous init: the browser path uses fetch+instantiateStreaming which
// Node cannot do. initSync seeds the same wasm singleton — identical to
// tests/integration/orchestrator-pake.test.ts.
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

const PEER_AUTHOR = encodePeerId("000000000000000a");
const PEER_B = encodePeerId("000000000000000b");
const PEER_C = encodePeerId("000000000000000c");
const PAKE_CODE = "482910";

function groupId(seed: number): GroupId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 19 + i) & 0xff;
  return encodeGroupId(bytes);
}

interface MemberKit {
  readonly session: GroupSession;
  readonly identity: IdentityKeyPair;
  readonly errors: unknown[];
  readonly messages: { readonly pub: PublicKey; readonly text: string }[];
}

async function makeMember(
  gid: GroupId,
  isAuthor: boolean,
  opts: { readonly authMode?: AuthMode; readonly pakeCode?: string } = {},
): Promise<MemberKit> {
  const identity = await generateIdentityKeyPair();
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const errors: unknown[] = [];
  const messages: { pub: PublicKey; text: string }[] = [];
  const session = new GroupSession({
    groupId: gid,
    identity,
    authMode: opts.authMode ?? AuthMode.Pake,
    pakeCode: opts.pakeCode ?? PAKE_CODE,
    isAuthor,
    repository,
    handshakeTimeoutMsOverride: 5000,
    handlers: {
      onError: (e) => errors.push(e),
      onMessage: (pub, text) => messages.push({ pub, text }),
    },
  });
  return { session, identity, errors, messages };
}

function connect(a: GroupSession, aPeerId: PeerId, b: GroupSession, bPeerId: PeerId): void {
  const { a: ta, b: tb } = linkLoopbackPair();
  a.attachLinkTransport(aPeerId, ta);
  b.attachLinkTransport(bPeerId, tb);
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe("GroupSession PAKE (SPAKE2) integration", () => {
  it("a 3-member PAKE group connects every link, gossips membership, and fans out text", async () => {
    const gid = groupId(1);
    const author = await makeMember(gid, true);
    const joinerB = await makeMember(gid, false);
    const joinerC = await makeMember(gid, false);

    connect(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
    await waitFor(() => author.session.memberList.length === 2, "author adopts B");
    await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");

    connect(author.session, PEER_C, joinerC.session, PEER_AUTHOR);
    await waitFor(() => author.session.memberList.length === 3, "author adopts C");
    await waitFor(() => joinerC.session.membership?.epoch === 3, "C adopts epoch 3");

    connect(joinerB.session, PEER_C, joinerC.session, PEER_B);
    await waitFor(
      () =>
        joinerB.session.linkState(PEER_C) === ConnectionState.Connected &&
        joinerC.session.linkState(PEER_B) === ConnectionState.Connected,
      "B<->C link connects under PAKE",
    );

    await joinerB.session.sendText("pake hello");
    await waitFor(
      () => author.messages.length === 1 && joinerC.messages.length === 1,
      "PAKE text fan-out",
    );
    expect(bytesEqual(author.messages[0]!.pub, joinerB.identity.publicKey)).toBe(true);
    expect(author.messages[0]!.text).toBe("pake hello");
  });

  it("a joiner with the wrong PAKE code never completes the link — author does not adopt it", async () => {
    const gid = groupId(2);
    const author = await makeMember(gid, true);
    const impostor = await makeMember(gid, false, { pakeCode: "999999" });

    connect(author.session, PEER_B, impostor.session, PEER_AUTHOR);

    // The confirmation tag mismatch aborts the handshake on BOTH sides —
    // there is no path to Connected and no membership adoption.
    await waitFor(
      () =>
        author.session.linkState(PEER_B) === ConnectionState.Disconnected ||
        author.session.linkState(PEER_B) === null,
      "author's link to impostor dies",
    );
    expect(author.session.memberList.length).toBe(1);
    expect(author.session.memberEpoch).toBe(1);
    const allErrors = [...author.errors, ...impostor.errors];
    expect(allErrors.some((e) => e instanceof PakeError && e.code === PakeErrorCode.Mismatch)).toBe(
      true,
    );
  });

  it("a safety-number joiner against a PAKE group fails the handshake (transcript mismatch)", async () => {
    const gid = groupId(3);
    const author = await makeMember(gid, true);
    const uncoded = new GroupSession({
      groupId: gid,
      identity: await generateIdentityKeyPair(),
      authMode: AuthMode.SafetyNumberOnly,
      isAuthor: false,
      repository: new InMemoryConversationRepository(generateAtRestKey()),
      handshakeTimeoutMsOverride: 5000,
    });

    connect(author.session, PEER_B, uncoded, PEER_AUTHOR);

    // The transcripts disagree on authMode → peer signature fails to verify.
    await waitFor(
      () =>
        author.session.linkState(PEER_B) === ConnectionState.Disconnected ||
        author.session.linkState(PEER_B) === null,
      "author's link to uncoded joiner dies",
    );
    expect(author.session.memberList.length).toBe(1);
    uncoded.leave();
  });

  it("rejects kickMember on a non-author PAKE session with NotAuthor", async () => {
    const gid = groupId(4);
    const author = await makeMember(gid, true);
    const joinerB = await makeMember(gid, false);
    connect(author.session, PEER_B, joinerB.session, PEER_AUTHOR);
    await waitFor(() => joinerB.session.membership?.epoch === 2, "B adopts epoch 2");
    await expect(joinerB.session.kickMember(author.identity.publicKey)).rejects.toMatchObject({
      code: GroupErrorCode.NotAuthor,
    });
  });
});
