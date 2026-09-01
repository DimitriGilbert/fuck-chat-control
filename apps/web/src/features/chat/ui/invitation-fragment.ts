/**
 * Extracts the invitation fragment from a URL hash, if present and well-formed.
 *
 * R7/F6 (Phase 8.3): the fragment may now carry an optional `~<code>` suffix
 * that conveys the 6-digit SPAKE2 password the responder needs to authenticate
 * the handshake via PAKE. Accepted shapes (after stripping the leading `#` and
 * lowercasing — see LW-8 below):
 *   - exactly 32 hex chars (`abcdef...`) — safety-number-only invite
 *   - 32 hex chars + `~` + exactly 6 decimal digits — PAKE-coded invite
 *
 * LW-8 (R7/F1): users may paste the hex portion in either case. The runtime's
 * {@link parseInvitation} case-normalizes before matching, but this gate runs
 * BEFORE it — a lowercase-only pattern here silently dropped uppercase-hex
 * links on the web (no join, no toast, no hash cleanup). The stripped fragment
 * is therefore lowercased BEFORE the pattern test, and the LOWERCASED fragment
 * is returned; the downstream `parseInvitation` re-normalizes anyway, so both
 * spellings reach the same conversation id.
 *
 * The PAKE code tail MUST be exactly 6 decimal digits per PRD #90; tails with
 * fewer digits are rejected (the orchestrator's {@link parseInvitation} raises
 * a loud PRD #90 error in that case). Returns <code>null</code> when there is
 * no hash or the hash is not a valid invitation fragment. The caller is
 * expected to be the landing route, which runs this on mount and whenever
 * <code>location.hash</code> changes. The fragment is never placed in a route
 * path or query string — it stays in the URL hash, which browsers do not send
 * to the server. The `~code` suffix rides in the same hash, so the PAKE
 * password never reaches the broker either.
 *
 * Returns the FULL bare fragment (hex + optional `~code`) so the orchestrator's
 * {@link parseInvitation} can extract the conversation id and the code.
 */
export function readInvitationFragment(hash: string): string | null {
  if (hash.length === 0) return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  // LW-8: normalize case BEFORE the lowercase-only pattern so uppercase-hex
  // links pass the gate; the runtime's parseInvitation re-normalizes, so the
  // lowercased return value is the canonical form downstream.
  const normalized = stripped.toLowerCase();
  if (!INVITATION_FRAGMENT.test(normalized)) return null;
  return normalized;
}

const INVITATION_FRAGMENT = /^[0-9a-f]{32}(~\d{6})?$/;
