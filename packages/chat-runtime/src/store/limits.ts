/**
 * Pre-auth size bounds for the export/import bundle (R8/F3). All caps are
 * enforced on the import path BEFORE the AEAD tag is verified, so a hostile
 * bundle cannot wedge the device in a pre-auth memory blow-up. Shared between
 * {@link base64ToBytes} (decoded-length check) and the envelope parser.
 */

/** Maximum total bundle JSON length (raw string bytes). 16 MiB. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** Maximum decoded byte length of `aead.ciphertext`. 16 MiB. */
export const MAX_ENVELOPE_CIPHERTEXT_BYTES = 16 * 1024 * 1024;

/** Maximum decoded byte length of `kdf.salt`. */
export const MAX_SALT_BYTES = 64;

/**
 * Minimum decoded byte length of `kdf.salt` (R8/F3 floor). Argon2id itself
 * requires ≥ 8 bytes; a shorter salt must be rejected as MalformedBundle
 * pre-auth rather than escaping the KDF as a raw Error.
 */
export const MIN_SALT_BYTES = 8;

/**
 * Maximum decoded byte length of `aead.nonce`. The pre-auth CEILING stays
 * loose — the exact 96-bit GCM length is enforced by the importer against
 * `GCM_NONCE_BYTES` (protocol/limits.ts) after the decode, so a wrong-length
 * nonce surfaces as MalformedBundle instead of CryptoError(InvalidArgument).
 */
export const MAX_NONCE_BYTES = 24;

/**
 * Maximum character length of a payload `peer.fingerprint` (R8/F4). The
 * production fingerprint is the 17-char safety number; test vectors use
 * 130-char hex. The cap rejects absurd/hostile values while leaving ample
 * headroom for either shape.
 */
export const MAX_FINGERPRINT_CHARS = 256;

/** Maximum number of conversations in a single bundle payload. */
export const MAX_CONVERSATIONS = 1024;

/** Maximum number of messages per conversation in a bundle payload. */
export const MAX_MESSAGES_PER_CONVERSATION = 100_000;

/**
 * Allowed Argon2id envelope parameter ranges (R8/F4).
 *
 * R4/F3: the maxima are pinned to the exporter's ACTUAL parameters — the
 * export path writes exactly m = 64 MiB (67108864) / t = 3 / p = 1 (see the
 * ARGON2_* constants in `export-bundle.ts`, mirroring `at-rest.ts`). No
 * legitimate bundle produced by this codebase ever exceeds them, so the
 * previous headroom (1 GiB / 10 / 4) bought no compatibility while letting a
 * hostile bundle demand a 16x-memory, 3.3x-iteration, 4-lane pre-auth KDF
 * cost: the importer pays for Argon2 BEFORE the AEAD tag is verified.
 */
export const ARGON2_VERSION_ALLOWED = 19;
export const ARGON2_MEMORY_MIN_BYTES = 8 * 1024 * 1024;
/** Exporter's exact memory cost: 64 MiB (ARGON2_MEMORY_BYTES in export-bundle.ts). */
export const ARGON2_MEMORY_MAX_BYTES = 67108864;
export const ARGON2_ITERATIONS_MIN = 1;
/** Exporter's exact iteration count (ARGON2_ITERATIONS in export-bundle.ts). */
export const ARGON2_ITERATIONS_MAX = 3;
export const ARGON2_PARALLELISM_MIN = 1;
/** Exporter's exact lane count (ARGON2_PARALLELISM in export-bundle.ts). */
export const ARGON2_PARALLELISM_MAX = 1;
