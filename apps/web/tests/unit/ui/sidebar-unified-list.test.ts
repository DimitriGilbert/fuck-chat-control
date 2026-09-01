import { describe, expect, it } from "vitest";

import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";

import { buildUnifiedSessions } from "@/features/chat/ui/sidebar";

/**
 * R7/F3: the sidebar list is a UNION of `state.conversations` and the live
 * `state.sessions` summaries. `clearConversation` deletes the record but
 * keeps the session alive (detached, no teardown), so a list derived from
 * records alone made a live session vanish from the sidebar while it still
 * held its signaling socket and peer connection. These tests pin the merge
 * the Sidebar renders — mirroring the pure-helper pattern of
 * sort-sessions.test.ts.
 */

const CONVERSATION_ID_BYTES = 16;

/**
 * Build a branded ConversationId from a number so tests get distinct,
 * value-comparable ids. ConversationId is a branded Uint8Array, so the double
 * cast through `unknown` is the project's established test pattern.
 */
function idFromNumber(n: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as ConversationId;
}

function makeRecord(
  overrides: Partial<Omit<ConversationRecord, "id">> & { id: ConversationId },
): ConversationRecord {
  return {
    createdAt: overrides.createdAt ?? 0,
    displayName: overrides.displayName ?? null,
    peer: overrides.peer ?? null,
    authFailed: overrides.authFailed ?? false,
    authFailedAt: overrides.authFailedAt ?? null,
    id: overrides.id,
  };
}

function makeSummary(
  overrides: Partial<Omit<SessionSummary, "id">> & { id: ConversationId },
): SessionSummary {
  return {
    label: overrides.label ?? "test",
    connectionState: overrides.connectionState ?? ConnectionState.Connected,
    unread: overrides.unread ?? 0,
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    lastMessageAt: overrides.lastMessageAt ?? null,
    safetyNumberVerified: overrides.safetyNumberVerified ?? false,
    authFailed: overrides.authFailed ?? false,
    authMode: overrides.authMode ?? AuthMode.SafetyNumberOnly,
    id: overrides.id,
  };
}

describe("buildUnifiedSessions (R7/F3 union list)", () => {
  it("returns an empty list when nothing is persisted and nothing is live", () => {
    expect(buildUnifiedSessions([], [])).toEqual([]);
  });

  it("uses the live session summary where both a record and a session exist", () => {
    const id = idFromNumber(1);
    const record = makeRecord({ id, displayName: "Alpha" });
    const live = makeSummary({ id, label: "Alpha (live)", lastMessageAt: 1_000 });
    const unified = buildUnifiedSessions([record], [live]);
    // Exactly one row, and it IS the live summary object (connection state,
    // unread, preview all come from the session, not the placeholder).
    expect(unified).toHaveLength(1);
    expect(unified[0]).toBe(live);
  });

  it("emits exactly one row per conversation when it is both recorded and live", () => {
    const id = idFromNumber(2);
    const record = makeRecord({ id });
    const live = makeSummary({ id });
    const unified = buildUnifiedSessions([record], [live]);
    expect(unified).toHaveLength(1);
  });

  it("renders a persisted-only record as an Idle placeholder summary", () => {
    const id = idFromNumber(3);
    const record = makeRecord({ id, displayName: "Ghost", createdAt: 1_234, authFailed: true });
    const unified = buildUnifiedSessions([record], []);
    expect(unified).toHaveLength(1);
    expect(unified[0]).toMatchObject({
      id,
      label: "Ghost",
      connectionState: ConnectionState.Idle,
      unread: 0,
      lastMessagePreview: null,
      lastMessageAt: 1_234,
      safetyNumberVerified: false,
      authFailed: true,
      // SEC-4: no live orchestrator means no negotiated auth mode.
      authMode: AuthMode.SafetyNumberOnly,
    });
  });

  it("falls back through deriveSessionLabel for anonymous records", () => {
    // No displayName and no pinned peer: the placeholder label must be the
    // runtime's "New chat" fallback, not an empty string.
    const anonymous = makeRecord({ id: idFromNumber(4) });
    expect(buildUnifiedSessions([anonymous], [])[0]!.label).toBe("New chat");
  });

  it("still lists a live session whose record was deleted (the R7/F3 regression)", () => {
    // clearConversation deletes the record but keeps the session alive; the
    // sidebar must not orphan a connected session behind a vanished row.
    const liveOnly = makeSummary({ id: idFromNumber(5), lastMessageAt: 2_000 });
    const otherRecord = makeRecord({ id: idFromNumber(6), createdAt: 500 });
    const unified = buildUnifiedSessions([otherRecord], [liveOnly]);
    expect(unified).toHaveLength(2);
    expect(unified).toContain(liveOnly);
  });

  it("orders the union most-recent-first (live timestamps compete with record createdAt)", () => {
    const recentLive = makeSummary({ id: idFromNumber(7), lastMessageAt: 2_000 });
    const staleRecord = makeRecord({ id: idFromNumber(8), createdAt: 100 });
    const newerRecord = makeRecord({ id: idFromNumber(9), createdAt: 1_500 });
    const unified = buildUnifiedSessions([staleRecord, newerRecord], [recentLive]);
    expect(unified.map((s) => s.lastMessageAt ?? 0)).toEqual([2_000, 1_500, 100]);
  });

  it("does not mutate its inputs", () => {
    const id = idFromNumber(10);
    const records = [makeRecord({ id })];
    const sessions = [makeSummary({ id })];
    const recordsBefore = records.slice();
    buildUnifiedSessions(records, sessions);
    expect(records).toEqual(recordsBefore);
    expect(sessions).toHaveLength(1);
  });
});
