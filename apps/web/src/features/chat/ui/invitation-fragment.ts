/**
 * Extracts the invitation fragment from a URL hash, if present and well-formed
 * (exactly 32 lowercase hex characters after the leading <code>#</code>).
 *
 * Returns <code>null</code> when there is no hash or the hash is not a valid
 * invitation fragment. The caller is expected to be the landing route, which
 * runs this on mount and whenever <code>location.hash</code> changes. The
 * fragment is never placed in a route path or query string — it stays in the
 * URL hash, which browsers do not send to the server.
 */
export function readInvitationFragment(hash: string): string | null {
  if (hash.length === 0) return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!HEX_32.test(stripped)) return null;
  return stripped;
}

const HEX_32 = /^[0-9a-f]{32}$/;
