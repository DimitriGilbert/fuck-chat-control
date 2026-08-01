import { describe, expect, it } from "vitest";

import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { sortSessions } from "@/features/chat/ui/sort-sessions";

/**
 * Factory for SessionSummary test fixtures. Only the fields that sortSessions
 * reads are filled; the rest are defaulted to keep fixtures short.
 */
function makeSummary(
  overrides: Partial<Omit<SessionSummary, "id">> & { id: ConversationId },
): SessionSummary {
  return {
    label: overrides.label ?? "test",
    connectionState: overrides.connectionState ?? "connected",
    unread: overrides.unread ?? 0,
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    lastMessageAt: overrides.lastMessageAt ?? null,
    safetyNumberVerified: overrides.safetyNumberVerified ?? false,
    authFailed: overrides.authFailed ?? false,
    authMode: overrides.authMode ?? AuthMode.SafetyNumberOnly,
    id: overrides.id,
  };
}

/**
 * Build a branded ConversationId from a number so tests get distinct,
 * comparable ids. ConversationId is a branded Uint8Array, so the double-cast
 * through `unknown` is the project's established test pattern.
 */
function idFromNumber(n: number): ConversationId {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n);
  return bytes as unknown as ConversationId;
}

describe("sortSessions", () => {
  it("returns a new array; the input is not mutated", () => {
    const a = makeSummary({ id: idFromNumber(1), lastMessageAt: 100 });
    const b = makeSummary({ id: idFromNumber(2), lastMessageAt: 50 });
    const input = [a, b];
    const sorted = sortSessions(input);
    expect(sorted).not.toBe(input);
    expect(input).toEqual([a, b]); // unchanged
    expect(sorted).toEqual([a, b]); // 100 before 50
  });

  it("orders by lastMessageAt descending (most recent first)", () => {
    const older = makeSummary({ id: idFromNumber(1), lastMessageAt: 1_000 });
    const newer = makeSummary({ id: idFromNumber(2), lastMessageAt: 2_000 });
    const middle = makeSummary({ id: idFromNumber(3), lastMessageAt: 1_500 });
    const result = sortSessions([older, newer, middle]);
    expect(result.map((s) => s.lastMessageAt)).toEqual([2_000, 1_500, 1_000]);
  });

  it("sorts sessions without a timestamp AFTER sessions with one (nulls last)", () => {
    const withTime = makeSummary({ id: idFromNumber(1), lastMessageAt: 100 });
    const noTime = makeSummary({ id: idFromNumber(2), lastMessageAt: null });
    const alsoNoTime = makeSummary({ id: idFromNumber(3), lastMessageAt: null });
    const result = sortSessions([noTime, withTime, alsoNoTime]);
    // The session with a timestamp wins; the two nulls follow after.
    expect(result[0]).toBe(withTime);
    expect(result.slice(1)).toEqual(expect.arrayContaining([noTime, alsoNoTime]));
  });

  it("keeps all-nulls-last even when many null sessions precede the one timestamp", () => {
    const withTime = makeSummary({ id: idFromNumber(99), lastMessageAt: 5 });
    const nulls = [
      makeSummary({ id: idFromNumber(1), lastMessageAt: null }),
      makeSummary({ id: idFromNumber(2), lastMessageAt: null }),
      makeSummary({ id: idFromNumber(3), lastMessageAt: null }),
    ];
    const result = sortSessions([...nulls, withTime]);
    expect(result[0]).toBe(withTime);
  });

  it("breaks timestamp ties stably via id comparison for deterministic order", () => {
    // Same timestamp; ids differ. The smaller id should sort first.
    const a = makeSummary({ id: idFromNumber(2), lastMessageAt: 500 });
    const b = makeSummary({ id: idFromNumber(1), lastMessageAt: 500 });
    const result = sortSessions([a, b]);
    expect(result).toEqual([b, a]);
  });

  it("does not reorder across multiple calls (pure + stable)", () => {
    const sessions = [
      makeSummary({ id: idFromNumber(1), lastMessageAt: 100 }),
      makeSummary({ id: idFromNumber(2), lastMessageAt: null }),
      makeSummary({ id: idFromNumber(3), lastMessageAt: 200 }),
    ];
    const first = sortSessions(sessions);
    const second = sortSessions(sessions);
    expect(first).toEqual(second);
  });

  it("handles an empty input array", () => {
    expect(sortSessions([])).toEqual([]);
  });
});
