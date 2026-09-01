import { createEnv } from "@t3-oss/env-core";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    // Intentionally empty. The browser bundle does not bake any ICE endpoints
    // into the client: the single source of STUN/TURN configuration is the
    // `/ice-config` route (see server.ts), which mints per-request TURN
    // credentials from the server-held TURN_SHARED_SECRET and returns the
    // PUBLIC endpoint coordinates at runtime. No client-side `VITE_*` fallback
    // is required or maintained.
  },
  // The pre-existing `as any` on import.meta.env is required because the
  // @t3-oss/env-core client runtime types import.meta.env loosely; refactoring
  // it is out of scope. No NEW `any` is introduced by this change.
  runtimeEnv: (import.meta as any).env,
  emptyStringAsUndefined: true,
});
