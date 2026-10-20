import { conversationIdToHex } from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
import { bytesToHex } from "@fuck-eu-chat-control/chat-runtime/store/encoding";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group/types";
import type { ChatControllerState } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";

/**
 * Decide whether a failed send's text may be written back into the session
 * draft. Extracted from chat-view.tsx; semantics unchanged.
 *
 * R7/F5 (Phase 12): restore only into an EMPTY draft. sendText makes a
 * network round-trip; resetting unconditionally would clobber whatever the
 * user typed while the send was in flight.
 *
 * R10F2 (Phase 9): with per-session drafts the restore additionally gates on
 * the send's target still being the ACTIVE conversation — restoring into a
 * different session's composer would leak the failed text across
 * conversations, the exact bug per-session drafts fix.
 *
 * The caller MUST pass the LIVE snapshot (`controller.getState()`), not a
 * render-time capture — the snapshot this function sees is what makes the
 * gating honest.
 */
export function shouldRestoreDraft(
  live: ChatControllerState | null,
  targetId: ConversationId,
): boolean {
  return (
    live !== null &&
    live.active !== null &&
    conversationIdToHex(live.active.id) === conversationIdToHex(targetId) &&
    live.active.draft === ""
  );
}

/**
 * The group counterpart of {@link shouldRestoreDraft} (protocol-v2): a
 * failed `sendGroupText` may write its text back only into an EMPTY draft
 * on the still-active group — never into a different group's composer.
 * `activeGroup.groupIdHex` is produced by the same lowercase-hex
 * normalization as {@link bytesToHex}, so the comparison stays
 * string-equality without a brand-unsafe cast.
 */
export function shouldRestoreGroupDraft(
  live: ChatControllerState | null,
  targetId: GroupId,
): boolean {
  return (
    live !== null &&
    live.activeGroup !== null &&
    live.activeGroup.groupIdHex === bytesToHex(targetId) &&
    live.activeGroup.draft === ""
  );
}
