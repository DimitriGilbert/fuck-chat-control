/**
 * Extracts the invitation fragment from a URL hash, if present and well-formed.
 *
 * R7/F6 (Phase 8.3): the fragment may now carry an optional `~<code>` suffix
 * that conveys the 6-digit SPAKE2 password the responder needs to authenticate
 * the handshake via PAKE. Accepted shapes (after stripping the leading `#`):
 *   - exactly 32 lowercase hex chars (`abcdef...`) — safety-number-only invite
 *   - 32 lowercase hex chars + `~` + 1..6 decimal digits — PAKE-coded invite
 *
 * Returns <code>null</code> when there is no hash or the hash is not a valid
 * invitation fragment. The caller is expected to be the landing route, which
 * runs this on mount and whenever <code>location.hash</code> changes. The
 * fragment is never placed in a route path or query string — it stays in the
 * URL hash, which browsers do not send to the server. The `~code` suffix
 * rides in the same hash, so the PAKE password never reaches the broker
 * either.
 *
 * Returns the FULL bare fragment (hex + optional `~code`) so the orchestrator's
 * {@link parseInvitation} can extract the conversation id and the code.
 */
export function readInvitationFragment(hash: string): string | null {
  if (hash.length === 0) return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!INVITATION_FRAGMENT.test(stripped)) return null;
  return stripped;
}

const INVITATION_FRAGMENT = /^[0-9a-f]{32}(~\d{1,6})?$/;
