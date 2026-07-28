import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    // Phase 0: PUBLIC ICE endpoints shipped to the browser bundle. These are
    // endpoint coordinates only (no secret material). The TURN credential pair
    // (username/credential) is minted per-request by the /ice-config route
    // from the server-held TURN_SHARED_SECRET (see server.ts); it is never
    // baked into the client. Optional so loopback/LAN/CI deployments keep
    // working with an empty iceServers list.
    VITE_STUN_URL: z.string().optional(),
    VITE_TURN_URL: z.string().optional(),
  },
  // The pre-existing `as any` on import.meta.env is required because the
  // @t3-oss/env-core client runtime types import.meta.env loosely; refactoring
  // it is out of scope for Phase 0. No NEW `any` is introduced by this change.
  runtimeEnv: (import.meta as any).env,
  emptyStringAsUndefined: true,
});
