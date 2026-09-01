import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";

/**
 * Order sessions for the sidebar: most-recent-first, nulls last.
 *
 * Rules:
 *   1. A session whose `lastMessageAt` is null sorts AFTER every session that
 *      has one. (New chats with no messages sink to the bottom.)
 *   2. Among sessions with timestamps, larger (more recent) timestamps win
 *      and sort first.
 *   3. Ties break to the id (string compare) for stable, deterministic order
 *      across renders.
 *
 * Pure and non-mutating; safe to call on every state snapshot.
 */
export function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  // Pre-allocate and copy so callers can pass a readonly view without aliasing.
  const copy = sessions.slice();
  copy.sort(compareByRecency);
  return copy;
}

function compareByRecency(a: SessionSummary, b: SessionSummary): number {
  const aHas = a.lastMessageAt !== null;
  const bHas = b.lastMessageAt !== null;
  if (aHas !== bHas) {
    // Sessions WITH a timestamp come first.
    return aHas ? -1 : 1;
  }
  if (aHas && bHas) {
    const aAt = a.lastMessageAt as number;
    const bAt = b.lastMessageAt as number;
    if (aAt !== bAt) return bAt - aAt; // most-recent first
  }
  // Stable tiebreak on id so React reconciliation doesn't jump rows on equal
  // timestamps (which is common for brand-new sessions created in the same
  // millisecond under test).
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
