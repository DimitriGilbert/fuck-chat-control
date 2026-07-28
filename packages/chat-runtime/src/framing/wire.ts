import { decodeFrameHeader, encodeFrameHeader } from "../protocol/codec";
import { ProtocolError } from "../protocol/errors";
import { FRAME_HEADER_BYTES, GCM_NONCE_BYTES } from "../protocol/limits";
import type { FrameAad, FrameHeader } from "../protocol/types";

import { FramingError, FramingErrorCode } from "./errors";

export function encodeWireFrame(
  header: FrameHeader,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `nonce must be ${GCM_NONCE_BYTES} bytes, got ${nonce.length}`,
    );
  }
  const headerBytes = encodeFrameHeader(header);
  const out = new Uint8Array(FRAME_HEADER_BYTES + GCM_NONCE_BYTES + ciphertext.length);
  out.set(headerBytes, 0);
  out.set(nonce, FRAME_HEADER_BYTES);
  out.set(ciphertext, FRAME_HEADER_BYTES + GCM_NONCE_BYTES);
  return out;
}

export interface WireFrame {
  readonly aad: FrameAad;
  readonly ciphertextLength: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export function decodeWireFrame(bytes: Uint8Array): WireFrame {
  if (bytes.length < FRAME_HEADER_BYTES + GCM_NONCE_BYTES) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `frame too short: ${bytes.length} bytes, need at least ${FRAME_HEADER_BYTES + GCM_NONCE_BYTES}`,
    );
  }
  let header: FrameHeader;
  try {
    header = decodeFrameHeader(bytes.subarray(0, FRAME_HEADER_BYTES));
  } catch (err) {
    if (err instanceof ProtocolError) {
      throw new FramingError(FramingErrorCode.Malformed, err.message);
    }
    throw err;
  }
  const nonce = bytes.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + GCM_NONCE_BYTES);
  const ciphertextStart = FRAME_HEADER_BYTES + GCM_NONCE_BYTES;
  const ciphertext = bytes.subarray(ciphertextStart, ciphertextStart + header.ciphertextLength);
  if (ciphertext.length !== header.ciphertextLength) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `ciphertext length ${ciphertext.length} does not match declared ${header.ciphertextLength}`,
    );
  }
  const trailing = bytes.length - ciphertextStart - header.ciphertextLength;
  if (trailing !== 0) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `frame has ${trailing} trailing bytes after declared ciphertext`,
    );
  }
  const aad: FrameAad = {
    protocolVersion: header.protocolVersion,
    senderSessionId: header.senderSessionId,
    senderSequence: header.senderSequence,
    frameType: header.frameType,
    transferId: header.transferId,
    chunkId: header.chunkId,
  };
  return { aad, ciphertextLength: header.ciphertextLength, nonce, ciphertext };
}
