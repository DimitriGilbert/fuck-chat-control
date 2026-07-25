export const ProtocolErrorCode = {
  InvalidVersion: "invalid_version",
  InvalidLength: "invalid_length",
  InvalidEnum: "invalid_enum",
  InvalidEncoding: "invalid_encoding",
  PointNotOnCurve: "point_not_on_curve",
  LimitExceeded: "limit_exceeded",
  InvalidRange: "invalid_range",
  InvalidFieldRelation: "invalid_field_relation",
  RoleIndeterminable: "role_indeterminable",
  Malformed: "malformed",
} as const;

export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProtocolError";
    this.code = code;
  }
}
