import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

/**
 * Surface logic for the handshake-authentication pill in the chat header,
 * extracted from chat-view.tsx; semantics unchanged.
 *
 * SEC-4: the pill labels the session's auth provenance. A session whose
 * handshake was authenticated by the extra 6-digit code carries the
 * stronger guarantee; a link-only session relies on post-hoc safety-number
 * comparison.
 *
 * R10F5 (Phase 9): label, styling, data-auth-mode, and aria-label all key
 * on `authMode` alone. A not-yet-connected code-protected session reads
 * "Extra code (pending)" so all four signals agree — never "Link only"
 * text wearing the code-protected styling.
 */

/** Plain-words label for the auth pill. */
export function authModeLabel(authMode: AuthMode, connectionState: ConnectionState): string {
  if (authMode === AuthMode.Pake) {
    return connectionState === ConnectionState.Connected ? "Extra code" : "Extra code (pending)";
  }
  return "Link only";
}

/** Stable selector attribute for tests and e2e. */
export function authModeDataValue(authMode: AuthMode): "pake" | "safety-number" {
  return authMode === AuthMode.Pake ? "pake" : "safety-number";
}

/** Accessible label for the pill's shield glyph. */
export function authModeGlyphLabel(authMode: AuthMode): string {
  return authMode === AuthMode.Pake
    ? "Protected by an extra code"
    : "Handshake authenticated by the link only";
}
