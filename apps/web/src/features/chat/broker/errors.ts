/**
 * Typed broker error model + application-defined WebSocket close codes.
 *
 * The broker is a server-side relay that speaks WebSocket: it cannot throw JS
 * errors across the wire, so protocol-level failures are signalled as RFC 6455
 * close frames with application-defined codes (4000-4999). The {@link BrokerError}
 * class mirrors {@link StoreError} so client/server code can branch on a typed
 * `code` after translating a close frame back into an error.
 */

export const BrokerErrorCode = {
  /** A socket that is already seated in a room sent a second `join`. */
  AlreadySeated: "AlreadySeated",
} as const;

export type BrokerErrorCode = (typeof BrokerErrorCode)[keyof typeof BrokerErrorCode];

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BrokerError";
    this.code = code;
  }
}

/**
 * RFC 6455 reserves 4000-4999 for application-defined close codes. Each entry
 * maps a {@link BrokerErrorCode} to the code sent on the wire and a stable
 * human-readable reason phrase. The reason phrase is informational and must not
 * carry secret material.
 */
export const BROKER_CLOSE_CODES: Readonly<Record<BrokerErrorCode, number>> = {
  AlreadySeated: 4003,
};

/**
 * The reason phrase sent alongside the close code. Kept server-side so the
 * close-code numbers stay the canonical identifier on the wire.
 */
export const BROKER_CLOSE_REASONS: Readonly<Record<BrokerErrorCode, string>> = {
  AlreadySeated: "socket already in a room; leave + reconnect required",
};
