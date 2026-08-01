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

/** Maximum decoded byte length of `aead.nonce`. */
export const MAX_NONCE_BYTES = 24;

/** Maximum number of conversations in a single bundle payload. */
export const MAX_CONVERSATIONS = 1024;

/** Maximum number of messages per conversation in a bundle payload. */
export const MAX_MESSAGES_PER_CONVERSATION = 100_000;

/** Allowed Argon2id envelope parameter ranges (R8/F4). */
export const ARGON2_VERSION_ALLOWED = 19;
export const ARGON2_MEMORY_MIN_BYTES = 8 * 1024 * 1024;
export const ARGON2_MEMORY_MAX_BYTES = 1 * 1024 * 1024 * 1024;
export const ARGON2_ITERATIONS_MIN = 1;
export const ARGON2_ITERATIONS_MAX = 10;
export const ARGON2_PARALLELISM_MIN = 1;
export const ARGON2_PARALLELISM_MAX = 4;
