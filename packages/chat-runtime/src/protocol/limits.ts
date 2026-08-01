export const PROTOCOL_VERSION = 0x01 as const;
export const TRANSCRIPT_VERSION = 0x01 as const;
export const EXPORT_BUNDLE_VERSION = 1 as const;

export const CONVERSATION_ID_BYTES = 16 as const;
export const SESSION_ID_BYTES = 32 as const;
export const PUBLIC_KEY_BYTES = 65 as const;
export const SIGNATURE_BYTES = 64 as const;
export const SEC1_UNCOMPRESSED_PREFIX = 0x04 as const;
export const GCM_NONCE_BYTES = 12 as const;

export const MAX_SEQUENCE = 0xffffffff as const;

export const MAX_TEXT_FRAME_BYTES = 16384 as const;
export const MAX_CHUNK_BYTES = 16384 as const;
export const MAX_MANIFEST_NAME_BYTES = 255 as const;
export const MAX_MANIFEST_MIME_BYTES = 127 as const;
export const MAX_MANIFEST_SIZE_BYTES = 0xffffffff as const;

export const MAX_CONCURRENT_TRANSFERS = 4 as const;
export const MAX_INCOMPLETE_TRANSFER_BYTES = 67108864 as const;
export const MAX_BUFFERED_DATA_BYTES = 1048576 as const;

export const REPLAY_WINDOW_SEQUENCES = 1024 as const;

export const HANDSHAKE_TIMEOUT_MS = 30000 as const;
export const FRAME_PARSE_TIMEOUT_MS = 5000 as const;

export const FRAME_HEADER_BYTES = 50 as const;
export const FRAME_AAD_BYTES = 46 as const;
export const TRANSCRIPT_BYTES = 343 as const;

export const HKDF_TRAFFIC_KEY_BYTES = 32 as const;
export const INIT_TO_RESP_LABEL = "fck-chat-v1/init->resp/traffic";
export const RESP_TO_INIT_LABEL = "fck-chat-v1/resp->init/traffic";

/**
 * SPAKE2 (RFC 9383) wire constants for the in-band PAKE exchange. Shares are
 * exchanged as cleartext handshake-length messages during the Handshaking
 * phase (before the encrypted framing layer is stood up). Layout:
 *   PROTOCOL_VERSION(1) | role(1) | share(33)
 * The role byte is the SPAKE2 side the sender played ('A'=0x41 / 'B'=0x42) so
 * each peer can confirm the two sides are complementary. The 6-digit code is
 * the SPAKE2 password; it never crosses the wire.
 */
export const PAKE_SHARE_BYTES = 33 as const;
export const PAKE_ROLE_A = 0x41 as const;
export const PAKE_ROLE_B = 0x42 as const;
export const PAKE_MESSAGE_BYTES = 35 as const;
export const PAKE_PROTOCOL_ID = "fuck-eu-chat-control/v1";
export const PAKE_SHARED_SECRET_BYTES = 32 as const;
/**
 * PAKE confirmation MAC. After both peers run `pakeFinish`, each derives a
 * confirmation tag = HMAC-SHA256(HKDF(pakeSecret, "pake-confirm"), transcriptHash)
 * and exchanges it. Because `pakeSecret` is identical iff the two codes match,
 * a mismatched MAC proves a wrong-code attack and the handshake aborts — there
 * is NO path to Connected under divergent traffic keys.
 *
 * Wire layout: PROTOCOL_VERSION(1) | role(1) | tag(32) = 34 bytes.
 */
export const PAKE_CONFIRM_TAG_BYTES = 32 as const;
export const PAKE_CONFIRM_MESSAGE_BYTES = 34 as const;
export const PAKE_CONFIRM_LABEL = "fck-chat-v1/pake-confirm";
