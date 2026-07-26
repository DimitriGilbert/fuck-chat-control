export { generateIdentityKeyPair, signTranscript, verifyTranscript } from "./identity";
export { generateEphemeralKeyPair, deriveSessionKeys } from "./session";
export { ReplayWindow, encryptFrame, decryptFrame } from "./aead";
export { computeSafetyNumber } from "./safety-number";
export { hmacSha256, sha256 } from "./primitives";
export {
  deriveKeyFromPassphrase,
  generateAtRestKey,
  encryptAtRest,
  decryptAtRest,
  wrapKey,
  unwrapKey,
} from "./at-rest";
export type { AtRestCiphertext } from "./at-rest";
export { CryptoError, CryptoErrorCode, PakeError, PakeErrorCode } from "./errors";
export {
  createPakeSession,
  derivePakeConfirmationTag,
  pakeOutgoingShare,
  pakeFinish,
  roleToSideByte,
  __setWasmModuleForTests,
} from "./pake";
export type { PakeSession, PakeWasmModule } from "./pake";
export type {
  AESKey,
  AtRestKey,
  WrappedKey,
  IdentityKeyPair,
  EphemeralKeyPair,
  SessionKeys,
  DeriveSessionKeysInput,
  EncryptedFrame,
} from "./types";
