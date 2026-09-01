/**
 * Constant-time byte equality comparison.
 *
 * Compares two byte arrays of equal length by XORing all corresponding bytes
 * and accumulating the OR of all XOR results. The function returns as soon as
 * the lengths differ (early return on length is acceptable — length is not a
 * secret in this codebase), but never short-circuits on byte content. This
 * defeats timing attacks against secret-derived comparisons such as PAKE
 * confirmation tags, replay-window nonces, and TOFU identity keys.
 *
 * Replaces the previous per-file `bytesEqual` copies whose early-return
 * per-byte loops leaked the index of the first differing byte through timing.
 */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
