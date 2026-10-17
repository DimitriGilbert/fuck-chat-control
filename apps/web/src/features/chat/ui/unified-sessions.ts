import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { deriveSessionLabel } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";

import { sortSessions } from "@/features/chat/ui/sort-sessions";

/**
 * Build the conversation list as a UNION of the persisted conversation
 * records and the live session summaries — the same merge the controller's
 * `buildState` exposes (live summary wins where both exist for an id).
 *
 * Extracted from sidebar.tsx so the desktop rail and the mobile home list
 * render the exact same merge; semantics are unchanged from the original
 * implementation.
 *
 * R7/F3: the list must NOT be derived from `state.conversations` alone.
 * `controller.clearConversation` deletes the record but keeps a live session
 * alive (`detached`, no teardown — chat-controller.ts), so a record-only list
 * made such a session vanish from the sidebar while it still held its
 * signaling socket and peer connection. Every live session therefore gets a
 * row even when no record exists for it; an active-but-unlisted conversation
 * cannot occur.
 *
 * Pure and non-mutating; sorted with {@link sortSessions}.
 */
export function buildUnifiedSessions(
  conversations: readonly ConversationRecord[],
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  const liveByKey = new Map<string, SessionSummary>();
  for (const s of sessions) liveByKey.set(conversationIdKey(s.id), s);
  const unified: SessionSummary[] = [];
  const listed = new Set<string>();
  for (const c of conversations) {
    const key = conversationIdKey(c.id);
    listed.add(key);
    const live = liveByKey.get(key);
    if (live !== undefined) {
      unified.push(live);
      continue;
    }
    // Persisted-only (no live session): default to Idle, no unread, no
    // preview. Sort by createdAt so stale chats don't all sink identically.
    // SEC-4: no live orchestrator means no negotiated auth mode; the safety-
    // number baseline matches the pre-PAKE fallback every persisted session
    // would otherwise display.
    unified.push({
      id: c.id,
      label: deriveSessionLabel(c, null),
      connectionState: ConnectionState.Idle,
      unread: 0,
      lastMessagePreview: null,
      lastMessageAt: c.createdAt,
      safetyNumberVerified: false,
      authFailed: c.authFailed,
      authMode: AuthMode.SafetyNumberOnly,
    });
  }
  // R7/F3: live sessions whose record was deleted (Delete conversation on a
  // live session) still list — the session is alive and selectable, so hiding
  // it would orphan a connected session behind an invisible row.
  for (const s of sessions) {
    if (!listed.has(conversationIdKey(s.id))) unified.push(s);
  }
  return sortSessions(unified);
}

/**
 * Stable hex key derived from a conversation id. ConversationId is a branded
 * Uint8Array, so identity-based Map/Set lookups and React keys both go
 * through this single normalization (shared by the sidebar list and the
 * empty-state resume rows).
 */
export function conversationIdKey(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}
