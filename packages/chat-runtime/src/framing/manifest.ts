import {
  MAX_CHUNK_BYTES,
  MAX_INCOMPLETE_TRANSFER_BYTES,
  MAX_MANIFEST_MIME_BYTES,
  MAX_MANIFEST_NAME_BYTES,
} from "../protocol/limits";

import { FramingError, FramingErrorCode } from "./errors";
import type { FileManifest } from "./types";

export { sha256 } from "../crypto/primitives";

const TRANSFER_ID_BYTES = 4;
const SIZE_BYTES = 4;
const CHUNK_COUNT_BYTES = 4;
const SHA256_BYTES = 32;
const GCM_TAG_BYTES = 16;

export const MAX_CHUNK_PLAINTEXT_BYTES = MAX_CHUNK_BYTES - GCM_TAG_BYTES;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function writeUint32Be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32Be(src: Uint8Array, offset: number): number {
  return (
    (src[offset] * 0x1000000 +
      (src[offset + 1] << 16) +
      (src[offset + 2] << 8) +
      src[offset + 3]) >>>
    0
  );
}

export function computeChunkCount(size: number): number {
  if (!Number.isInteger(size) || size < 0) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `size must be a non-negative integer, got ${size}`,
    );
  }
  if (size === 0) return 0;
  return Math.ceil(size / MAX_CHUNK_PLAINTEXT_BYTES);
}

export function chunkBoundaries(size: number, chunkIndex: number): { start: number; end: number } {
  const start = chunkIndex * MAX_CHUNK_PLAINTEXT_BYTES;
  const end = Math.min(start + MAX_CHUNK_PLAINTEXT_BYTES, size);
  return { start, end };
}

export function encodeManifest(manifest: FileManifest): Uint8Array {
  if (
    !Number.isInteger(manifest.transferId) ||
    manifest.transferId < 0 ||
    manifest.transferId > 0xffffffff
  ) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `transferId must be uint32, got ${manifest.transferId}`,
    );
  }
  const nameBytes = TEXT_ENCODER.encode(manifest.name);
  if (nameBytes.length > MAX_MANIFEST_NAME_BYTES) {
    throw new FramingError(
      FramingErrorCode.SizeExceeded,
      `name length ${nameBytes.length} exceeds ${MAX_MANIFEST_NAME_BYTES}`,
    );
  }
  if (nameBytes.length === 0) {
    throw new FramingError(FramingErrorCode.Malformed, "name must not be empty");
  }
  const mimeBytes = TEXT_ENCODER.encode(manifest.mimeType);
  if (mimeBytes.length > MAX_MANIFEST_MIME_BYTES) {
    throw new FramingError(
      FramingErrorCode.SizeExceeded,
      `mimeType length ${mimeBytes.length} exceeds ${MAX_MANIFEST_MIME_BYTES}`,
    );
  }
  if (manifest.contentHash.length !== SHA256_BYTES) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `contentHash must be ${SHA256_BYTES} bytes, got ${manifest.contentHash.length}`,
    );
  }
  if (
    !Number.isInteger(manifest.size) ||
    manifest.size < 0 ||
    manifest.size > MAX_INCOMPLETE_TRANSFER_BYTES
  ) {
    throw new FramingError(
      FramingErrorCode.SizeExceeded,
      `size ${manifest.size} exceeds MAX_INCOMPLETE_TRANSFER_BYTES (${MAX_INCOMPLETE_TRANSFER_BYTES})`,
    );
  }
  const expectedChunkCount = computeChunkCount(manifest.size);
  if (manifest.chunkCount !== expectedChunkCount) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `chunkCount ${manifest.chunkCount} does not match canonical ${expectedChunkCount} for size ${manifest.size}`,
    );
  }

  const total =
    TRANSFER_ID_BYTES +
    1 +
    nameBytes.length +
    1 +
    mimeBytes.length +
    SIZE_BYTES +
    CHUNK_COUNT_BYTES +
    SHA256_BYTES;
  const out = new Uint8Array(total);
  let offset = 0;
  writeUint32Be(out, offset, manifest.transferId);
  offset += TRANSFER_ID_BYTES;
  out[offset++] = nameBytes.length;
  out.set(nameBytes, offset);
  offset += nameBytes.length;
  out[offset++] = mimeBytes.length;
  out.set(mimeBytes, offset);
  offset += mimeBytes.length;
  writeUint32Be(out, offset, manifest.size);
  offset += SIZE_BYTES;
  writeUint32Be(out, offset, manifest.chunkCount);
  offset += CHUNK_COUNT_BYTES;
  out.set(manifest.contentHash, offset);
  return out;
}

export function decodeManifest(plaintext: Uint8Array, expectedTransferId: number): FileManifest {
  if (plaintext.length < TRANSFER_ID_BYTES + 2) {
    throw new FramingError(FramingErrorCode.Malformed, "manifest plaintext too short");
  }
  let offset = 0;
  const transferId = readUint32Be(plaintext, offset);
  offset += TRANSFER_ID_BYTES;
  if (transferId !== expectedTransferId) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `manifest transferId ${transferId} does not match frame transferId ${expectedTransferId}`,
    );
  }
  const nameLength = plaintext[offset++];
  if (offset + nameLength > plaintext.length) {
    throw new FramingError(FramingErrorCode.Malformed, "manifest name overruns plaintext");
  }
  const name = TEXT_DECODER.decode(plaintext.subarray(offset, offset + nameLength));
  offset += nameLength;
  if (nameLength === 0) {
    throw new FramingError(FramingErrorCode.Malformed, "name must not be empty");
  }
  if (nameLength > MAX_MANIFEST_NAME_BYTES) {
    throw new FramingError(
      FramingErrorCode.SizeExceeded,
      `name length ${nameLength} exceeds ${MAX_MANIFEST_NAME_BYTES}`,
    );
  }
  if (offset >= plaintext.length) {
    throw new FramingError(FramingErrorCode.Malformed, "manifest truncated before mimeType length");
  }
  const mimeLength = plaintext[offset++];
  if (offset + mimeLength > plaintext.length) {
    throw new FramingError(FramingErrorCode.Malformed, "manifest mimeType overruns plaintext");
  }
  const mimeType = TEXT_DECODER.decode(plaintext.subarray(offset, offset + mimeLength));
  offset += mimeLength;
  if (mimeLength > MAX_MANIFEST_MIME_BYTES) {
    throw new FramingError(
      FramingErrorCode.SizeExceeded,
      `mimeType length ${mimeLength} exceeds ${MAX_MANIFEST_MIME_BYTES}`,
    );
  }
  if (offset + SIZE_BYTES + CHUNK_COUNT_BYTES + SHA256_BYTES > plaintext.length) {
    throw new FramingError(FramingErrorCode.Malformed, "manifest truncated before fixed tail");
  }
  const size = readUint32Be(plaintext, offset);
  offset += SIZE_BYTES;
  const chunkCount = readUint32Be(plaintext, offset);
  offset += CHUNK_COUNT_BYTES;
  const contentHash = plaintext.subarray(offset, offset + SHA256_BYTES);
  offset += SHA256_BYTES;
  if (offset !== plaintext.length) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `manifest has ${plaintext.length - offset} trailing bytes`,
    );
  }
  if (!Number.isInteger(size) || size < 0 || size > MAX_INCOMPLETE_TRANSFER_BYTES) {
    throw new FramingError(
      FramingErrorCode.SizeExceeded,
      `size ${size} exceeds MAX_INCOMPLETE_TRANSFER_BYTES (${MAX_INCOMPLETE_TRANSFER_BYTES})`,
    );
  }
  const expectedChunkCount = computeChunkCount(size);
  if (chunkCount !== expectedChunkCount) {
    throw new FramingError(
      FramingErrorCode.Malformed,
      `chunkCount ${chunkCount} does not match canonical ${expectedChunkCount} for size ${size}`,
    );
  }
  return { transferId, name, mimeType, size, chunkCount, contentHash };
}
