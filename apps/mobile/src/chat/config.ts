/**
 * Runtime configuration: broker URL, base URL, and ICE config endpoint.
 *
 * Dev vs prod selection uses Expo's release channel (`expo-release-channels`
 * inlined into Constants) plus a build-time `EXPO_PUBLIC_*` override. The
 * dev defaults point at the host loopback alias seen from the Android
 * emulator (`10.0.2.2` maps to the developer machine's localhost), so a
 * broker running locally on the dev box is reachable without extra setup.
 *
 * Prod defaults point at the deployed broker + web origin. Override either
 * via `EXPO_PUBLIC_BROKER_URL` / `EXPO_PUBLIC_BASE_URL` (set in the EAS build
 * profile or `.env`) for a self-hosted deployment.
 */
import Constants, { ExecutionEnvironment } from "expo-constants";

export interface RuntimeConfig {
  /** WebSocket URL the signaling layer dials. */
  readonly brokerUrl: string;
  /** HTTP origin used to format invitation links + reach `/ice-config`. */
  readonly baseUrl: string;
}

/**
 * Read a release-channel-scoped value from the `extra` block in app.json.
 * The keys are templated as `brokerUrl:dev` / `brokerUrl:prod` so the config
 * travels with the app manifest; `EXPO_PUBLIC_*` overrides win.
 */
function readExtra(key: string, envOverride: string, fallback: string): string {
  const fromEnv = process.env[envOverride];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  const extra = Constants.expoConfig?.extra as Record<string, string | undefined> | undefined;
  const channel =
    Constants.executionEnvironment === ExecutionEnvironment.Standalone ? "prod" : "dev";
  const keyed = extra?.[`${key}:${channel}`];
  return keyed ?? fallback;
}

/**
 * R8:F2: release builds must not silently downgrade signaling or the ICE/
 * TURN-credential fetch to cleartext. A misconfigured operator build (e.g.
 * `EXPO_PUBLIC_BROKER_URL=ws://…` baked into a Standalone binary) used to be
 * accepted without a peep — the app just spoke plaintext forever. In the
 * Standalone/release channel we now THROW on any non-`wss://` broker URL or
 * non-`https://` base URL, at controller construction time (the first
 * `resolveRuntimeConfig()` call), so the failure is loud instead of silent.
 * Dev builds (Expo Go / dev client) keep `ws://` + `http://` allowed for the
 * loopback/LAN workflow.
 *
 * The error is REDACTED: it names the field and the offending SCHEME only —
 * never the full URL, credentials, or host — so a crash report cannot leak
 * deployment details.
 */
function assertSecureReleaseScheme(value: string, field: "brokerUrl" | "baseUrl"): void {
  const isRelease =
    Constants.executionEnvironment === ExecutionEnvironment.Standalone ||
    Constants.expoConfig?.extra?.["releaseChannel"] === "prod";
  if (!isRelease) return;
  const required = field === "brokerUrl" ? "wss://" : "https://";
  if (!value.startsWith(required)) {
    const scheme = value.split(":", 1)[0] ?? "";
    throw new Error(
      `Insecure runtime config in release build: ${field} must start with "${required}" ` +
        `(got scheme "${scheme}:"). Rebuild with a secure EXPO_PUBLIC_${field === "brokerUrl" ? "BROKER" : "BASE"}_URL.`,
    );
  }
}

/**
 * The dev broker URL targets `10.0.2.2`, the Android emulator's alias for the
 * host loopback. iOS simulators reach `localhost` directly; a physical device
 * needs a LAN IP — override via `EXPO_PUBLIC_BROKER_URL`.
 */
export function resolveRuntimeConfig(): RuntimeConfig {
  const brokerUrl = readExtra("brokerUrl", "EXPO_PUBLIC_BROKER_URL", "ws://10.0.2.2:8080/ws");
  const baseUrl = readExtra("baseUrl", "EXPO_PUBLIC_BASE_URL", "http://10.0.2.2:8080");
  assertSecureReleaseScheme(brokerUrl, "brokerUrl");
  assertSecureReleaseScheme(baseUrl, "baseUrl");
  return { brokerUrl, baseUrl };
}

/**
 * Fetch the ICE server list from the broker's `/ice-config` endpoint. Returns
 * `[]` on any failure so loopback/LAN/CI deployments (where the endpoint may
 * be unconfigured) keep working with host-candidate-only WebRTC. A failed
 * fetch MUST NOT break controller construction — mirrors the web provider's
 * posture.
 */
export async function fetchIceServers(): Promise<
  readonly {
    readonly urls: string | readonly string[];
    readonly username?: string;
    readonly credential?: string;
  }[]
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const { baseUrl } = resolveRuntimeConfig();
    const response = await fetch(`${baseUrl}/ice-config`, {
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { readonly iceServers?: unknown };
    if (!Array.isArray(body.iceServers)) return [];
    return body.iceServers as readonly {
      readonly urls: string | readonly string[];
      readonly username?: string;
      readonly credential?: string;
    }[];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
