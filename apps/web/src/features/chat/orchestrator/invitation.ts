import { randomBytes } from "@/features/chat/crypto/primitives";
import { encodeConversationId } from "@/features/chat/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@/features/chat/protocol/limits";
import type { ConversationId } from "@/features/chat/protocol/types";

import { OrchestratorError, OrchestratorErrorCode } from "./errors";

/**
 * R7/F6 (Phase 8.3): the invitation fragment now carries an optional PAKE
 * code suffix. The bare conversation id is 32 lowercase hex chars; the new
 * `~<code>` tail carries the 6-digit SPAKE2 password the responder needs to
 * derive the same traffic keys as the initiator. The code is optional —
 * safety-number-only invitations parse exactly as before.
 *
 * The PAKE code length is bounded to 1..6 decimal digits (matches the PRD's
 * "6-digit code" wording while still accepting shorter codes for tests and
 * future flexibility). The hex portion is unchanged so existing invitation
 * links keep round-tripping.
 */
const HEX_CHARS_PATTERN = /^[0-9a-f]{32}$/;
const HEX_WITH_CODE_PATTERN = /^[0-9a-f]{32}~\d{1,6}$/;

export function generateConversationId(): ConversationId {
  return encodeConversationId(randomBytes(CONVERSATION_ID_BYTES));
}

export function conversationIdToHex(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToConversationId(hex: string): ConversationId {
  if (!HEX_CHARS_PATTERN.test(hex)) {
    throw new OrchestratorError(
      OrchestratorErrorCode.MalformedInvitation,
      "invitation fragment must be exactly 32 lowercase hex characters [0-9a-f]",
    );
  }
  const out = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return encodeConversationId(out);
}

export function formatInvitation(id: ConversationId, baseUrl: string): string {
  const trimmed = baseUrl.endsWith("#") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}#${conversationIdToHex(id)}`;
}

/**
 * R7/F6 (Phase 8.3 / Phase 10): format an invitation link that carries the
 * 6-digit PAKE code in the URL fragment. The code is appended as `~<code>`
 * after the 32-hex conversation id; the entire tail stays in the hash, so
 * browsers never send it to the server. The responder's
 * {@link parseInvitation} extracts both halves.
 *
 * Use this when the initiator wants PAKE authentication against a malicious
 * broker. The code must ALSO be conveyed to the responder via a side channel
 * for full protection: an attacker who intercepts THIS link gets the code
 * too. The link alone is a convenience for the common case where Alice pastes
 * it into the same chat she is already having with Bob (e.g. over Signal); a
 * determined MITM who intercepts the link itself is outside the threat model
 * of the 6-digit code.
 */
export function formatCodedInvitation(
  id: ConversationId,
  baseUrl: string,
  code: string,
): string {
  if (code.length === 0) {
    return formatInvitation(id, baseUrl);
  }
  const trimmed = baseUrl.endsWith("#") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}#${conversationIdToHex(id)}~${code}`;
}

/**
 * Result of parsing an invitation fragment. The PAKE `code` is null for
 * safety-number-only invitations; non-null when the initiator appended
 * `~<code>` to carry the SPAKE2 password out-of-band alongside the
 * conversation id.
 */
export interface ParsedInvitation {
  readonly conversationId: ConversationId;
  readonly code: string | null;
}

/**
 * Parse an invitation fragment into the conversation id plus any PAKE code
 * the initiator embedded. Accepts:
 *   - bare hex: `abcdef0123456789abcdef0123456789`
 *   - leading-hash: `#abcdef...`
 *   - hex+code: `abcdef...~123456` or `#abcdef...~123456`
 *
 * The hex portion MUST be 32 lowercase hex chars; the optional `~code` tail
 * MUST be 1..6 decimal digits. Anything else throws
 * {@link OrchestratorErrorCode.MalformedInvitation}.
 */
export function parseInvitation(fragment: string): ParsedInvitation {
  const stripped = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (HEX_CHARS_PATTERN.test(stripped)) {
    return { conversationId: hexToConversationId(stripped), code: null };
  }
  if (HEX_WITH_CODE_PATTERN.test(stripped)) {
    const tildeIdx = stripped.indexOf("~");
    if (tildeIdx < 0) {
      // Defensive: regex guarantees the tilde is present; this branch is
      // unreachable but keeps the narrowing explicit for the type checker.
      throw new OrchestratorError(
        OrchestratorErrorCode.MalformedInvitation,
        "invitation fragment with code missing '~' separator",
      );
    }
    const hexPart = stripped.slice(0, tildeIdx);
    const codePart = stripped.slice(tildeIdx + 1);
    return { conversationId: hexToConversationId(hexPart), code: codePart };
  }
  // Re-run hexToConversationId on the stripped fragment to surface the
  // canonical "32 lowercase hex" error message for malformed inputs that
  // match neither shape (preserves the pre-Phase-8 error contract).
  return { conversationId: hexToConversationId(stripped), code: null };
}
