export const OrchestratorErrorCode = {
  MalformedInvitation: "MalformedInvitation",
  MalformedHandshakeMessage: "MalformedHandshakeMessage",
  HandshakeSignatureMismatch: "HandshakeSignatureMismatch",
  IdentityChanged: "IdentityChanged",
  NotConnected: "NotConnected",
  AlreadyStarted: "AlreadyStarted",
  HandshakeFailed: "HandshakeFailed",
  /**
   * R8/F1 (Phase 6): raised when an invitation carrying a `~code` (PAKE
   * password) is joined against an orchestrator constructed with
   * {@link OrchestratorDeps.enablePake} === false. v1 mobile builds ship with
   * PAKE gated off (the wasm pkg is Metro-blocked), so a `~code` deep link
   * would otherwise reach {@link createPakeSession} → {@link loadWasm} and
   * crash mid-handshake. This is a feature-gate rejection, NOT a protocol
   * failure: distinguishable so the mobile UI can surface "coded invitations
   * are not supported in this build" rather than a generic handshake error.
   * Web/desktop never set the flag (default true) and never see this code.
   */
  PakeDisabled: "PakeDisabled",
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
