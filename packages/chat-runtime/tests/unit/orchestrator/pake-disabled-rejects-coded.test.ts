import { describe, expect, it } from "vitest";

import {
  generateAtRestKey,
  generateIdentityKeyPair,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { IdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { InMemoryConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationRepository } from "@fuck-eu-chat-control/chat-runtime/store";

import {
  ConversationOrchestrator,
  type OrchestratorDeps,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/errors";

import { mockSocketFactory, MockSignalingSocket } from "./_helpers";

const SAMPLE_BASE_URL = "https://app.example";

/**
 * R8/F1 (Phase 6) regression: a v1 mobile build (enablePake: false) MUST reject
 * a `~code` (PAKE) invitation at the orchestrator's join parse boundary, BEFORE
 * any createPakeSession/loadWasm call — instead of crashing mid-handshake the
 * way it did when the only gate was the Metro blockList on the wasm pkg.
 *
 * The gate lives in {@link ConversationOrchestrator.join} and throws
 * {@link OrchestratorErrorCode.PakeDisabled}, a distinguishable code so the
 * mobile UI can surface "coded invitations are not supported in this build".
 *
 * These tests construct the orchestrator directly with OrchestratorDeps (the
 * same seam the production chat-session.ts builder uses) so they exercise the
 * real join() code path without spinning up a controller or WebRTC bridge.
 */

interface Kit {
  readonly orchestrator: ConversationOrchestrator;
  readonly repository: ConversationRepository;
  readonly identity: IdentityKeyPair;
  readonly socket: MockSignalingSocket;
}

async function makeOrchestrator(enablePake: boolean): Promise<Kit> {
  const repository = new InMemoryConversationRepository(generateAtRestKey());
  const identity = await generateIdentityKeyPair();
  const socket = new MockSignalingSocket();
  const deps: OrchestratorDeps = {
    brokerUrl: "wss://broker.example",
    baseUrl: SAMPLE_BASE_URL,
    repository,
    socketFactory: mockSocketFactory(socket),
    identity,
    // No handlers: join() does not emit before the gate fires, and the
    // enablePake:true non-rejection case only asserts the auth mode flip (no
    // handshake is run, so no onStateChange/onError is expected).
    enablePake,
  };
  return { orchestrator: new ConversationOrchestrator(deps), repository, identity, socket };
}

describe("ConversationOrchestrator PAKE feature gate (R8/F1 / Phase 6)", () => {
  describe("enablePake: false rejects coded invitations at the join boundary", () => {
    it("throws OrchestratorError(PakeDisabled) on a bare <32hex>~<code> fragment", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      // join() is one-shot (flips `started`), so assert BOTH the type and the
      // code on a single call via try/catch — a second join() would throw
      // AlreadyStarted and mask the gate.
      let caught: unknown = null;
      try {
        await orchestrator.join("abcdef0123456789abcdef0123456789~123456");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrchestratorError);
      expect((caught as OrchestratorError).code).toBe(OrchestratorErrorCode.PakeDisabled);
    });

    it("throws PakeDisabled on a full https://...#<hex>~<code> link", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      await expect(
        orchestrator.join("https://app.example#abcdef0123456789abcdef0123456789~654321"),
      ).rejects.toMatchObject({ code: OrchestratorErrorCode.PakeDisabled });
    });

    it("throws PakeDisabled on a leading-# coded fragment", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      await expect(
        orchestrator.join("#abcdef0123456789abcdef0123456789~000042"),
      ).rejects.toMatchObject({ code: OrchestratorErrorCode.PakeDisabled });
    });

    it("the thrown error message is user-facing-distinguishable (mentions coded/PAKE)", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      let caught: unknown = null;
      try {
        await orchestrator.join("abcdef0123456789abcdef0123456789~123456");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrchestratorError);
      expect((caught as OrchestratorError).code).toBe(OrchestratorErrorCode.PakeDisabled);
      // The mobile UI keys off the code, but the message must still be
      // distinguishable from a generic handshake failure for diagnostics.
      expect((caught as OrchestratorError).message).toMatch(/coded|pake/i);
    });

    it("does NOT flip authMode to Pake (the gate fires before any PAKE state is set)", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      // The gate throws inside join() before the `parsed.code !== null` block
      // that writes pakeCode/authMode=Pake. handshakeAuthMode must stay the
      // SafetyNumberOnly default — proving no PAKE session creation was reached.
      expect(orchestrator.handshakeAuthMode).toBe(AuthMode.SafetyNumberOnly);
      await expect(
        orchestrator.join("abcdef0123456789abcdef0123456789~123456"),
      ).rejects.toMatchObject({ code: OrchestratorErrorCode.PakeDisabled });
      expect(orchestrator.handshakeAuthMode).toBe(AuthMode.SafetyNumberOnly);
    });
  });

  describe("enablePake: false ACCEPTS uncoded invitations (gate is code-specific)", () => {
    it("joins a bare <32hex> fragment without throwing", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      // UNCoded invitations negotiate SafetyNumberOnly and never touch the
      // wasm-gated PAKE path, so they must be accepted even on mobile.
      await expect(orchestrator.join("abcdef0123456789abcdef0123456789")).resolves.toBeUndefined();
      expect(orchestrator.handshakeAuthMode).toBe(AuthMode.SafetyNumberOnly);
    });

    it("joins a leading-# uncoded fragment without throwing", async () => {
      const { orchestrator } = await makeOrchestrator(false);

      await expect(orchestrator.join("#abcdef0123456789abcdef0123456789")).resolves.toBeUndefined();
      expect(orchestrator.handshakeAuthMode).toBe(AuthMode.SafetyNumberOnly);
    });

    it("persists the conversation on a successful uncoded join", async () => {
      const { orchestrator, repository } = await makeOrchestrator(false);

      await orchestrator.join("abcdef0123456789abcdef0123456789");

      const list = await repository.listConversations();
      expect(list.length).toBe(1);
    });
  });

  describe("enablePake: true (default) leaves the coded-invitation path unchanged", () => {
    it("does NOT throw PakeDisabled on a <32hex>~<code> fragment (web/desktop behavior)", async () => {
      const { orchestrator } = await makeOrchestrator(true);

      // With PAKE enabled, join() must reach the existing path: it accepts the
      // coded fragment and flips authMode to Pake. We do NOT run the full
      // handshake here (that needs the wasm + a peer; covered by the PAKE
      // integration tests) — the unit assertion is that the gate does not fire
      // and the auth-mode flip still happens.
      await expect(
        orchestrator.join("abcdef0123456789abcdef0123456789~123456"),
      ).resolves.toBeUndefined();
      expect(orchestrator.handshakeAuthMode).toBe(AuthMode.Pake);
    });

    it("enablePake defaults to true when omitted (omission is web/desktop)", async () => {
      const repository = new InMemoryConversationRepository(generateAtRestKey());
      const identity = await generateIdentityKeyPair();
      const socket = new MockSignalingSocket();
      // Omit enablePake entirely — must behave as true.
      const deps: OrchestratorDeps = {
        brokerUrl: "wss://broker.example",
        baseUrl: SAMPLE_BASE_URL,
        repository,
        socketFactory: mockSocketFactory(socket),
        identity,
      };
      const orchestrator = new ConversationOrchestrator(deps);

      await expect(
        orchestrator.join("abcdef0123456789abcdef0123456789~999999"),
      ).resolves.toBeUndefined();
      expect(orchestrator.handshakeAuthMode).toBe(AuthMode.Pake);
    });
  });
});
