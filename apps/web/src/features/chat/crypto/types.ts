import type { Brand, PublicKey, Signature, Transcript } from "../protocol/types";

export type AESKey = Brand<Uint8Array, "AESKey">;

export type AtRestKey = AESKey;

export type WrappedKey = Brand<Uint8Array, "WrappedKey">;

export interface IdentityKeyPair {
  readonly publicKey: PublicKey;
  readonly privateKey: Uint8Array;
  sign(transcript: Transcript): Promise<Signature>;
}

export interface EphemeralKeyPair {
  readonly publicKey: PublicKey;
  readonly privateKey: Uint8Array;
}

export interface SessionKeys {
  readonly sendKey: AESKey;
  readonly recvKey: AESKey;
}

export interface DeriveSessionKeysInput {
  readonly localEcdhPrivateKey: Uint8Array;
  readonly peerEcdhPublicKey: PublicKey;
  readonly transcript: Transcript;
  readonly localIdentityPublicKey: PublicKey;
}

export interface EncryptedFrame {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
}
