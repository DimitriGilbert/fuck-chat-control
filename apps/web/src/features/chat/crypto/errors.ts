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
