export const CryptoErrorCode = {
  InvalidArgument: "invalid_argument",
  AuthenticationFailed: "authentication_failed",
  ReplayDuplicate: "replay_duplicate",
  ReplayStale: "replay_stale",
  WrongPassphrase: "wrong_passphrase",
  IdentityNotInTranscript: "identity_not_in_transcript",
} as const;

export type CryptoErrorCode = (typeof CryptoErrorCode)[keyof typeof CryptoErrorCode];

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CryptoError";
    this.code = code;
  }
}

/**
 * PAKE (SPAKE2) error codes. `Mismatch` is the interactivity-preserving case:
 * the protocol completed but the two sides derived different secrets (wrong
 * code). `InvalidShare` covers a malformed peer share (wrong length or a point
 * not on the curve). `Abort` covers protocol-level aborts (wrong side byte,
 * replay, or a peer offering `SafetyNumberOnly` against a `Pake` invitation).
 */
export const PakeErrorCode = {
  Mismatch: "pake_mismatch",
  InvalidShare: "pake_invalid_share",
  Abort: "pake_abort",
} as const;

export type PakeErrorCode = (typeof PakeErrorCode)[keyof typeof PakeErrorCode];

export class PakeError extends Error {
  readonly code: PakeErrorCode;

  constructor(code: PakeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PakeError";
    this.code = code;
  }
}
