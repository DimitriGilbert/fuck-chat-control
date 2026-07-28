import { describe, expect, it } from "vitest";

import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationOrchestrator } from "@fuck-eu-chat-control/chat-runtime/orchestrator/orchestrator";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { activeSessionView, summarizeSession } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import type { ChatSession } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import type { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import type { ReceivedFile } from "@fuck-eu-chat-control/chat-runtime/framing";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";

/**
 * SEC-4 (Phase 2): prove authMode flows end-to-end from the orchestrator's
 * negotiated handshake mode through the two pure view derivations the UI
 * consumes (`summarizeSession` for the sidebar, `activeSessionView` for the
 * status bar + security sheet).
 *
 * Driving a real PAKE handshake at the UI layer requires a broker + WebRTC
 * loopback pair, which the integration suites cover (see
 * tests/integration/orchestrator-pake.test.ts). Here we exercise the seam the
 * plan calls out — the orchestrator's `handshakeAuthMode` getter — with a
 * minimal stubbed orchestrator, mirroring the established fake-session pattern
 * in tests/unit/runtime/teardown-clears-files.test.ts.
 */

/**
 * Minimal orchestrator stub: only `handshakeAuthMode` is read by
 * summarizeSession/activeSessionView. Cast through `unknown` to satisfy the
 * `ConversationOrchestrator` type, matching the project's test-fake convention.
 * `mode` is held in a mutable holder so the renegotiation test can flip it
 * in place — ChatSession.orchestrator is readonly, but the getter reads live.
 */
function makeFakeOrchestrator(initialMode: AuthMode): {
  readonly orchestrator: ConversationOrchestrator;
  setMode(next: AuthMode): void;
} {
  let mode = initialMode;
  return {
    orchestrator: {
      get handshakeAuthMode(): AuthMode {
        return mode;
      },
    } as unknown as ConversationOrchestrator,
    setMode(next: AuthMode): void {
      mode = next;
    },
  };
}

const CONVERSATION_ID_BYTES = 16;

function deterministicId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return bytes as unknown as ConversationId;
}

/**
 * Build a ChatSession with only the fields summarizeSession/activeSessionView
 * actually read. The stubs for orchestrator/bridge/receivedFiles are present
 * only to satisfy the type; the view functions touch orchestrator.handshakeAuthMode
 * and none of bridge/receivedFiles.
 */
function makeSession(overrides: {
  readonly id: ConversationId;
  readonly authMode: AuthMode;
  readonly connectionState?: ConnectionState;
}): { readonly session: ChatSession; readonly setMode: (next: AuthMode) => void } {
  const record: ConversationRecord | null = null;
  const fake = makeFakeOrchestrator(overrides.authMode);
  const session: ChatSession = {
    id: overrides.id,
    orchestrator: fake.orchestrator,
    bridge: { close(): void {} } as unknown as WebRtcBridge,
    connectionState: overrides.connectionState ?? ConnectionState.Connected,
    messages: [],
    safetyNumber: null,
    safetyNumberVerified: false,
    unread: 0,
    draft: "",
    invitation: null,
    record,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastReceivedAt: null,
    transfers: [],
    receivedFiles: new Map<number, ReceivedFile>(),
    detached: false,
    authFailed: false,
    authMode: overrides.authMode,
  };
  return { session, setMode: fake.setMode };
}

describe("authMode surface (SEC-4 / PRD #95)", () => {
  describe("summarizeSession", () => {
    it("copies AuthMode.Pake from the orchestrator onto the sidebar summary", () => {
      const { session } = makeSession({
        id: deterministicId(1),
        authMode: AuthMode.Pake,
      });
      const summary = summarizeSession(session);
      expect(summary.authMode).toBe(AuthMode.Pake);
    });

    it("copies AuthMode.SafetyNumberOnly from the orchestrator onto the sidebar summary", () => {
      const { session } = makeSession({
        id: deterministicId(2),
        authMode: AuthMode.SafetyNumberOnly,
      });
      const summary = summarizeSession(session);
      expect(summary.authMode).toBe(AuthMode.SafetyNumberOnly);
    });

    it("preserves all sibling fields when surfacing authMode (no field dropped)", () => {
      // Guards against a regression where adding authMode to the returned
      // literal accidentally shadows another field. Build a PAKE session,
      // assert authMode AND the pre-existing fields all come through.
      const { session } = makeSession({
        id: deterministicId(3),
        authMode: AuthMode.Pake,
        connectionState: ConnectionState.Connected,
      });
      const summary = summarizeSession(session);
      expect(summary).toMatchObject({
        authMode: AuthMode.Pake,
        authFailed: false,
        safetyNumberVerified: false,
        unread: 0,
        connectionState: ConnectionState.Connected,
      });
    });
  });

  describe("activeSessionView", () => {
    it("returns null for no active session (the controller's empty-state path)", () => {
      expect(activeSessionView(null)).toBeNull();
    });

    it("copies AuthMode.Pake onto the active session snapshot after a PAKE handshake", () => {
      // PRD #95: a connected session that completed a PAKE handshake must
      // surface AuthMode.Pake so the status bar shows the PAKE pill and the
      // security sheet shows the live PAKE provenance.
      const { session } = makeSession({
        id: deterministicId(4),
        authMode: AuthMode.Pake,
        connectionState: ConnectionState.Connected,
      });
      const view = activeSessionView(session);
      expect(view).not.toBeNull();
      expect(view!.authMode).toBe(AuthMode.Pake);
      // The status bar's auth pill keys off the active view's authMode AND the
      // connected flag; assert the pairing the UI renders.
      expect(view!.connectionState).toBe(ConnectionState.Connected);
    });

    it("reports AuthMode.SafetyNumberOnly for a safety-number-only session", () => {
      const { session } = makeSession({
        id: deterministicId(5),
        authMode: AuthMode.SafetyNumberOnly,
        connectionState: ConnectionState.Connected,
      });
      const view = activeSessionView(session);
      expect(view).not.toBeNull();
      expect(view!.authMode).toBe(AuthMode.SafetyNumberOnly);
    });

    it("reflects a renegotiated mode: the same session view flips when the orchestrator's getter does", () => {
      // The view functions read the orchestrator's live getter rather than a
      // snapshot taken at construction. This test pins that contract: build a
      // session whose orchestrator reports SafetyNumberOnly, then flip the
      // getter's backing value to Pake and re-derive — the view must follow.
      // (ChatSession.orchestrator is readonly, so the swap goes through the
      // fake's setMode, not a reassignment of the field.)
      const { session, setMode } = makeSession({
        id: deterministicId(6),
        authMode: AuthMode.SafetyNumberOnly,
      });
      expect(activeSessionView(session)!.authMode).toBe(AuthMode.SafetyNumberOnly);

      setMode(AuthMode.Pake);
      expect(activeSessionView(session)!.authMode).toBe(AuthMode.Pake);
      expect(summarizeSession(session).authMode).toBe(AuthMode.Pake);
    });
  });

  describe("AuthMode enum contract (guards against a value rename)", () => {
    // Phase 1's identity-manager tests already import AuthMode as a value from
    // @fuck-eu-chat-control/chat-runtime/protocol/types. These two assertions pin the exact
    // member names the UI layer (chat-view / sidebar / settings-sheet) relies
    // on; if either member is renamed, the build would still pass but the
    // rendered pill/glyph would silently break.
    it("exposes AuthMode.Pake with the documented numeric value", () => {
      expect(AuthMode.Pake).toBe(0x02);
    });

    it("exposes AuthMode.SafetyNumberOnly with the documented numeric value", () => {
      expect(AuthMode.SafetyNumberOnly).toBe(0x01);
    });
  });
});
