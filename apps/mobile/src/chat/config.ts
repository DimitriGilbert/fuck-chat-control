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
import Constants from 'expo-constants';

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
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  const extra = Constants.expoConfig?.extra as Record<string, string | undefined> | undefined;
  const channel =
    Constants.executionContext === 'store' ? 'prod' : 'dev';
  const keyed = extra?.[`${key}:${channel}`];
  return keyed ?? fallback;
}

/**
 * The dev broker URL targets `10.0.2.2`, the Android emulator's alias for the
 * host loopback. iOS simulators reach `localhost` directly; a physical device
 * needs a LAN IP — override via `EXPO_PUBLIC_BROKER_URL`.
 */
export function resolveRuntimeConfig(): RuntimeConfig {
  const brokerUrl = readExtra(
    'brokerUrl',
    'EXPO_PUBLIC_BROKER_URL',
    'ws://10.0.2.2:8080/ws',
  );
  const baseUrl = readExtra(
    'baseUrl',
    'EXPO_PUBLIC_BASE_URL',
    'http://10.0.2.2:8080',
  );
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
  readonly { readonly urls: string | readonly string[]; readonly username?: string; readonly credential?: string }[]
> {
  try {
    const { baseUrl } = resolveRuntimeConfig();
    const response = await fetch(`${baseUrl}/ice-config`);
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
  }
}
