export const OrchestratorErrorCode = {
  MalformedInvitation: "MalformedInvitation",
  MalformedHandshakeMessage: "MalformedHandshakeMessage",
  HandshakeSignatureMismatch: "HandshakeSignatureMismatch",
  IdentityChanged: "IdentityChanged",
  NotConnected: "NotConnected",
  AlreadyStarted: "AlreadyStarted",
  HandshakeFailed: "HandshakeFailed",
} as const;

export type OrchestratorErrorCode =
  (typeof OrchestratorErrorCode)[keyof typeof OrchestratorErrorCode];

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;

  constructor(code: OrchestratorErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OrchestratorError";
    this.code = code;
  }
}
