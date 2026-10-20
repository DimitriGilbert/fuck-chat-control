import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { GroupMemberView } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

/**
 * Phase 7b (protocol-v2): pure display helpers for group membership — the
 * member-sheet sort order, the display-name/key-prefix label fallback shared
 * by the member rows and the transcript's sender captions, the per-link
 * status vocabulary, and the byte-accurate name clamp. Kept out of the .tsx
 * files so the views and the unit tests share one source of truth.
 */

const UTF8_ENCODER = new TextEncoder();

/**
 * Byte-accurate clamp for the member display name. The protocol cap
 * ({@link MAX_MEMBER_DISPLAY_NAME}) counts UTF-8 BYTES while DOM inputs and
 * `window.prompt` count UTF-16 code units — a multibyte name could otherwise
 * slip past the input cap and make `startGroup`/`setGroupDisplayName` throw
 * on encode (group-session.ts). `for…of` iterates code points, so a
 * surrogate pair is never split mid-clamp.
 */
export function clampUtf8Bytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = UTF8_ENCODER.encode(char).length;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

/** Identity public key rendered as lowercase hex (the member's fingerprint). */
export function publicKeyHex(key: PublicKey): string {
  let hex = "";
  for (let i = 0; i < key.length; i++) {
    hex += key[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Truncated fingerprint form shown wherever a member announced no name. */
export function shortKeyLabel(identityPubHex: string): string {
  return `${identityPubHex.slice(0, 8)}…`;
}

/**
 * Member label: the announced display name, else the short identity-key
 * prefix. One fallback for both the members sheet and the transcript's
 * sender captions so an unnamed member reads identically in both places.
 */
export function memberDisplayLabel(
  member: Pick<GroupMemberView, "displayName" | "identityPubHex">,
): string {
  return member.displayName.length > 0 ? member.displayName : shortKeyLabel(member.identityPubHex);
}

/**
 * Sender caption for a received group message: resolve the authenticated
 * sender key against the member list and fall back to the raw key prefix
 * when the sender is no longer listed (e.g. just removed).
 */
export function senderLabel(
  senderIdentityPub: PublicKey,
  members: readonly GroupMemberView[],
): string {
  const hex = publicKeyHex(senderIdentityPub);
  const member = members.find((m) => m.identityPubHex === hex);
  if (member !== undefined) return memberDisplayLabel(member);
  return shortKeyLabel(hex);
}

/**
 * Three-way read of a member's pairwise link (protocol-v2 §6): up, still
 * being established (waiting/signaling/handshaking/verifying), or down.
 * `null` means no link exists — the self entry reports null, and the row
 * overrides self with "This device" before consulting this label.
 */
export function memberLinkLabel(linkState: ConnectionState | null): string {
  if (linkState === null) return "No link";
  switch (linkState) {
    case ConnectionState.Connected:
      return "Connected";
    case ConnectionState.Idle:
    case ConnectionState.Disconnected:
      return "Disconnected";
    default:
      return "Connecting";
  }
}

/** Visual tone for the member row's status dot, derived from the link state. */
export type MemberLinkTone = "connected" | "connecting" | "disconnected";

export function memberLinkTone(linkState: ConnectionState | null): MemberLinkTone {
  if (linkState === ConnectionState.Connected) return "connected";
  if (
    linkState === ConnectionState.Waiting ||
    linkState === ConnectionState.Signaling ||
    linkState === ConnectionState.Handshaking ||
    linkState === ConnectionState.Verifying
  ) {
    return "connecting";
  }
  return "disconnected";
}

/**
 * Display order for the members sheet: the author first (the sole list
 * signer/admin), then everyone else by display label — announced name when
 * set, key prefix otherwise — with the identity hex as a stable tie-break so
 * members with equal names never reorder between renders. Non-mutating.
 */
export function sortGroupMembers(members: readonly GroupMemberView[]): GroupMemberView[] {
  return [...members].sort(compareMembers);
}

function compareMembers(a: GroupMemberView, b: GroupMemberView): number {
  if (a.isAuthor !== b.isAuthor) return a.isAuthor ? -1 : 1;
  const aLabel = memberDisplayLabel(a).toLowerCase();
  const bLabel = memberDisplayLabel(b).toLowerCase();
  if (aLabel !== bLabel) return aLabel < bLabel ? -1 : 1;
  if (a.identityPubHex === b.identityPubHex) return 0;
  return a.identityPubHex < b.identityPubHex ? -1 : 1;
}
