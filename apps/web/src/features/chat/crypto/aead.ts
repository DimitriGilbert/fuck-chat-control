import { deriveNonce, encodeAad } from "../protocol/codec";
import { GCM_NONCE_BYTES, REPLAY_WINDOW_SEQUENCES } from "../protocol/limits";
import type { FrameAad } from "../protocol/types";

import { CryptoError, CryptoErrorCode } from "./errors";
import { aesGcmDecrypt, aesGcmEncrypt } from "./primitives";
import type { AESKey, EncryptedFrame } from "./types";

const UINT32_MAX = 0xffffffff;

function assertUint32Sequence(seq: number): void {
  if (!Number.isInteger(seq) || seq < 0 || seq > UINT32_MAX) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `sequence must be an unsigned uint32 integer, got ${seq}`,
    );
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class ReplayWindow {
  private highest = -1;
  private readonly slots: Uint8Array;

  constructor(readonly size: number = REPLAY_WINDOW_SEQUENCES) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new CryptoError(
        CryptoErrorCode.InvalidArgument,
        `replay window size must be a positive integer, got ${size}`,
      );
    }
    this.slots = new Uint8Array(size);
  }

  observe(sequence: number): void {
    assertUint32Sequence(sequence);
    if (sequence > this.highest) {
      const advance = sequence - this.highest;
      if (advance >= this.size) {
        this.slots.fill(0);
      } else {
        for (let i = this.size - 1 - advance; i >= 0; i--) {
          this.slots[i + advance] = this.slots[i];
        }
        for (let i = 0; i < advance; i++) this.slots[i] = 0;
      }
      this.highest = sequence;
      this.slots[0] = 1;
      return;
    }
    const offset = this.highest - sequence;
    if (offset >= this.size) {
      throw new CryptoError(
        CryptoErrorCode.ReplayStale,
        `sequence ${sequence} is outside the replay window (highest=${this.highest}, size=${this.size})`,
      );
    }
    if (this.slots[offset] === 1) {
      throw new CryptoError(
        CryptoErrorCode.ReplayDuplicate,
        `sequence ${sequence} has already been observed`,
      );
    }
    this.slots[offset] = 1;
  }
}

export async function encryptFrame(
  key: AESKey,
  aad: FrameAad,
  plaintext: Uint8Array,
): Promise<EncryptedFrame> {
  assertUint32Sequence(aad.senderSequence);
  const aadBytes = encodeAad(aad);
  const nonce = deriveNonce(aad.senderSessionId, aad.senderSequence);
  const ciphertext = await aesGcmEncrypt(key, nonce, aadBytes, plaintext);
  return { ciphertext, nonce };
}

export async function decryptFrame(
  key: AESKey,
  replayWindow: ReplayWindow,
  aad: FrameAad,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new CryptoError(
      CryptoErrorCode.InvalidArgument,
      `nonce must be ${GCM_NONCE_BYTES} bytes, got ${nonce.length}`,
    );
  }
  assertUint32Sequence(aad.senderSequence);
  const expectedNonce = deriveNonce(aad.senderSessionId, aad.senderSequence);
  if (!bytesEqual(nonce, expectedNonce)) {
    throw new CryptoError(
      CryptoErrorCode.AuthenticationFailed,
      "nonce does not match the derived nonce for this sender session id and sequence",
    );
  }
  replayWindow.observe(aad.senderSequence);
  const aadBytes = encodeAad(aad);
  return aesGcmDecrypt(key, nonce, aadBytes, ciphertext);
}
