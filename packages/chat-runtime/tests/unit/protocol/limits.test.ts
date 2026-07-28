import { describe, expect, it } from "vitest";

import {
  CONVERSATION_ID_BYTES,
  FRAME_AAD_BYTES,
  FRAME_HEADER_BYTES,
  GCM_NONCE_BYTES,
  MAX_BUFFERED_DATA_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CONCURRENT_TRANSFERS,
  MAX_INCOMPLETE_TRANSFER_BYTES,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
  MAX_MANIFEST_SIZE_BYTES,
  MAX_SEQUENCE,
  MAX_TEXT_FRAME_BYTES,
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  REPLAY_WINDOW_SEQUENCES,
  SESSION_ID_BYTES,
  SIGNATURE_BYTES,
  TRANSCRIPT_BYTES,
  TRANSCRIPT_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  FRAME_PARSE_TIMEOUT_MS,
} from "@fuck-eu-chat-control/chat-runtime/protocol/limits";

describe("protocol v1 frozen limits", () => {
  it("pins the version and width constants", () => {
    expect(PROTOCOL_VERSION).toBe(0x01);
    expect(TRANSCRIPT_VERSION).toBe(0x01);
    expect(CONVERSATION_ID_BYTES).toBe(16);
    expect(SESSION_ID_BYTES).toBe(32);
    expect(PUBLIC_KEY_BYTES).toBe(65);
    expect(SIGNATURE_BYTES).toBe(64);
    expect(GCM_NONCE_BYTES).toBe(12);
    expect(FRAME_AAD_BYTES).toBe(46);
    expect(FRAME_HEADER_BYTES).toBe(50);
    expect(TRANSCRIPT_BYTES).toBe(343);
  });

  it("pins the operational limits", () => {
    expect(MAX_SEQUENCE).toBe(0xffffffff);
    expect(MAX_TEXT_FRAME_BYTES).toBe(16384);
    expect(MAX_CHUNK_BYTES).toBe(16384);
    expect(MAX_MANIFEST_NAME_BYTES).toBe(255);
    expect(MAX_MANIFEST_MIME_BYTES).toBe(127);
    expect(MAX_MANIFEST_SIZE_BYTES).toBe(0xffffffff);
    expect(MAX_CONCURRENT_TRANSFERS).toBe(4);
    expect(MAX_INCOMPLETE_TRANSFER_BYTES).toBe(67108864);
    expect(MAX_BUFFERED_DATA_BYTES).toBe(1048576);
    expect(REPLAY_WINDOW_SEQUENCES).toBe(1024);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(30000);
    expect(FRAME_PARSE_TIMEOUT_MS).toBe(5000);
  });
});
