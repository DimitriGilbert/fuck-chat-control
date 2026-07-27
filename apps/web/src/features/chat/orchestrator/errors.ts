export const OrchestratorErrorCode = {
  MalformedInvitation: "MalformedInvitation",
  MalformedHandshakeMessage: "MalformedHandshakeMessage",
  HandshakeSignatureMismatch: "HandshakeSignatureMismatch",
  IdentityChanged: "IdentityChanged",
  NotConnected: "NotConnected",
  AlreadyStarted: "AlreadyStarted",
  HandshakeFailed: "HandshakeFailed",
  /**
   * Raised when persisting the durable auth-failed flag fails — i.e. the
   * localStorage write in `auth-failed-store.ts` rejected. The in-memory cache
   * is still authoritative for the synchronous `retry()` gate, so this is
   * surfaced for diagnostics rather than blocking teardown.
   */
  DurableStoreWriteFailed: "DurableStoreWriteFailed",
} as const;

export type OrchestratorErrorCode =
  (typeof OrchestratorErrorCode)[keyof typeof OrchestratorErrorCode];

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly cause?: unknown;

  constructor(code: OrchestratorErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = "OrchestratorError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
