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
export const HKDF_NONCE_BASE_BYTES = 12 as const;
export const INIT_TO_RESP_LABEL = "fck-chat-v1/init->resp/traffic";
export const RESP_TO_INIT_LABEL = "fck-chat-v1/resp->init/traffic";
export const NONCE_BASE_LABEL = "fck-chat-v1/nonce-base";
