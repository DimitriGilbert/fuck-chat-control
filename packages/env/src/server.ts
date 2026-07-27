import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    // CR-16: optional so an unset var is a no-op in the broker's origin guard
    // (dev/preview/local never configure it). Enforced only when an operator
    // sets it in production — see apps/web/src/server/broker.ts.
    CORS_ORIGIN: z.url().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
