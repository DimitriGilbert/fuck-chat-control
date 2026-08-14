# Deployment Guide

Operator guide for deploying `fuck-eu-chat-control`. Covers the deployment
model, ports, TLS and WSS, the runtime configuration surface, logging and
metadata, and NAT traversal. For the security properties themselves, read
the [threat model](../architecture/threat-model.md) and the
[protocol spec](../architecture/protocol-v1.md); this document is about
running the thing.

The compose file ships a coturn service for STUN and TURN. Credentials are
minted per request by the Nitro server from a shared secret that never
reaches the client. Loopback and LAN work with nothing configured;
connections across the internet need the operator to publish the coturn
ports and set the endpoint environment variables below.

## 1. The single-process model

The TanStack Start (Nitro) server is the only process. It serves:

- The SSR React application (HTML, JS, CSS, assets) over HTTPS.
- The signaling broker as a WebSocket route at `/ws`, on the same port as
  the app.
- `GET /ice-config`, which returns the public STUN/TURN endpoints and a
  freshly minted, time-limited TURN credential pair. The shared secret used
  to mint those credentials comes from `TURN_SHARED_SECRET` and is never
  sent to the client.

There is no separate broker host. The broker is an in-process WebSocket
handler at `apps/web/src/server/broker.ts` that keeps no persistent state,
no presence table, and no application logs. Once a WebRTC data channel
opens between two peers, both disconnect from the broker. (See "What the
system protects" in the threat model.)

A separate `coturn` container is defined in `docker-compose.yml` alongside
`web`. `web` is HTTP behind traefik and uses `expose:`, so it stays on the
Docker network. `coturn` speaks UDP and must be published on the host with
`ports:` — an HTTP reverse proxy cannot relay TURN traffic. The port list
is in §2 and §6.

The broker is served from the same origin as the app, so the client works
out its broker URL as `wss://<host>/ws` from `window.location` at runtime
(`apps/web/src/features/chat/runtime/chat-provider.tsx`,
`resolveBrowserDeps`). No broker URL is configured server-side.

### ICE configuration

The ICE server list is runtime configuration, not a build-time constant.
The browser fetches `GET /ice-config` at boot (same origin, relative URL)
and passes the result into the controller:

```ts
const instance = createChatController({
  // ...
  iceServers, // fetched from /ice-config, falls back to [] on failure
});
```

The route (`apps/web/src/server/ice-config.ts`) builds the list from
server-side environment variables (`STUN_URL`, `TURN_URL`, `TURN_TLS_URL`)
and, for TURN entries, mints a fresh HMAC-SHA1 long-term credential per
request using the TURN REST API (time-limited credentials):

- `username = "<unix-expiry-seconds>:fck-web"`
- `credential = base64( HMAC-SHA1(TURN_SHARED_SECRET, username) )`
- credential lifetime is 6 hours; the route sets
  `Cache-Control: public, max-age=3600` so the browser re-fetches before
  expiry.

The shared secret (`TURN_SHARED_SECRET`) is read from the environment and
used only to compute the credential. It is never serialized into a
response, never baked into the client bundle, and never written to logs.
Only the resulting `username` and `credential` reach the browser.

When nothing is configured (loopback, LAN, CI), `/ice-config` returns
`{ iceServers: [] }` and the client falls back to host candidates — which
is how `localhost`-to-`localhost` connections work with no STUN/TURN. A
fetch failure is also swallowed and falls back to `[]`, so the UI never
blocks waiting for ICE config.

## 2. Ports

| Port        | Protocol | Purpose                                                             | Required?                                        |
| ----------- | -------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| 443         | HTTPS    | App + broker `/ws` + `/ice-config` (WSS after the proxy upgrades).  | Yes.                                             |
| 3478        | UDP      | STUN + TURN relay (coturn).                                         | Yes for cross-network P2P; optional for LAN.     |
| 3478        | TCP      | TURN relay, TCP fallback for UDP-blocking networks.                 | Recommended; needed on UDP-blocking networks.    |
| 5349        | TCP      | TURN over TLS (`turns:`).                                           | Optional; needs cert/pkey mounted in coturn.     |
| 49152-49172 | UDP      | TURN relay allocation range (matches coturn `min-port`/`max-port`). | Yes when TURN is enabled; widen for more relays. |

The `web` service listens on TCP 9000 inside the container
(`ENV PORT=9000`, `ENV HOST=0.0.0.0` in `apps/web/Dockerfile`). The compose
file uses `expose: ["9000"]` rather than `ports:` for `web`, so the service
is reachable only on the Docker network — Dokploy/traefik (or your reverse
proxy) reaches it as `http://web:9000`, and it is never published on a host
interface. In production, terminate TLS at a reverse proxy in front of the
node server and expose 443 to the internet. Do not publish the `web`
container port on a host interface.

The `coturn` service is the exception: it uses `ports:` and is published on
the host, because STUN and TURN speak UDP and cannot be proxied by an HTTP
reverse proxy. Operators must publish 3478/udp, 3478/tcp, 5349/tcp (if using
`turns:`), and the full relay range 49152-49172/udp on the host firewall.
coturn reads its config from `deploy/coturn/turnserver.conf` (mounted
read-only). The config parser does NOT expand `$VARIABLE` tokens, so the
shared secret and realm are NOT written into that file — instead
`deploy/coturn/entrypoint.sh` reads `TURN_SHARED_SECRET` and `TURN_REALM`
from the runtime environment and passes them to `turnserver` as
`--static-auth-secret` / `--realm` CLI flags after `-c …turnserver.conf`.
CLI flags override config-file values in coturn, so the secret/realm reach
the parser as the resolved shell values rather than the literal
`$TURN_…` strings (which would open the relay).

The `/ws` route must be reached over WSS (secure WebSocket) in production.
A plain-WS broker reachable over HTTP is not acceptable: the signaling
channel carries invitation-bearing rendezvous messages, and the threat
model's guarantees assume TLS/WSS-encrypted signaling. The client derives
`wss://` from `window.location` when the app is served over HTTPS, so this
happens on its own as long as the proxy terminates TLS correctly.

### Reverse-proxy WebSocket upgrade

The proxy in front of the node server must forward the WebSocket upgrade
headers for `/ws`. Without that, the broker handshake fails and peers cannot
rendezvous.

nginx:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}

location / {
    proxy_pass http://127.0.0.1:9000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Caddy (automatic HTTPS and WebSocket pass-through by default):

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:9000
}
```

Traefik (YAML):

```yaml
http:
  routers:
    chat:
      rule: "Host(`chat.example.com`)"
      service: chat
      tls: {}
  services:
    chat:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9000"
```

> On Dokploy (and any Docker-network setup), point the proxy at the service
> name on the compose network — `http://web:9000` — rather than
> `127.0.0.1:9000`. The `127.0.0.1` form applies only when the proxy runs on
> the host alongside the container.

The app does not validate `X-Forwarded-Proto` directly; it reads
`window.location.protocol`, so the proxy's TLS termination is what makes the
client pick `wss://`.

## 3. TLS / WSS

Terminate TLS at the reverse proxy (Caddy, nginx, Traefik, or the hosting
platform's HTTPS layer) in front of the node server. The node process speaks
HTTP on port 9000 inside the container and does not present certificates.

- The broker URL is derived as
  `${protocol === "https:" ? "wss" : "ws"}://${host}/ws` from
  `window.location`, so when the proxy serves the app over HTTPS the broker
  URL is `wss://` automatically.
- The conversation ID is carried in the URL fragment, which browsers never
  send to the server in an HTTP request. TLS still protects the rest of the
  URL and the signaling payloads in transit.

## 4. Docker

Build and run from the repository root:

```bash
docker compose up -d --build
```

This builds `apps/web/Dockerfile` (node:24, builds the SSR bundle with
`pnpm run build`, runs `.output/server/index.mjs`) and starts it with the
healthcheck below. The compose file uses `expose: ["9000"]` (Docker-network
only, not published on a host interface) and sets `restart: unless-stopped`.

### Health check

The compose healthcheck hits `http://localhost:9000/` every 10 seconds and
expects a 2xx. The `GET /` is the health endpoint: it returns the SSR'd
landing page with HTTP 200 and produces no application-level chat or broker
logs. There is no separate `/healthz`; `/` is it. coturn's healthcheck is a
TCP connect on 3478.

### Production environment variables

The server env surface is small. From `packages/env/src/server.ts`:

| Variable              | Required | Purpose                                                                                            |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | Yes      | `production` (set in the Dockerfile).                                                              |
| `CORS_ORIGIN`         | No       | The origin allowed for CORS. Set to your deployed origin.                                          |
| `PUBLIC_BASE_URL`     | No       | The public origin used as the invitation-link prefix (surfaced to the client via `/ice-config`).   |
| `STUN_URL`            | No       | Public STUN endpoint, e.g. `stun:turn.example.com:3478`. Served to the client via `/ice-config`.   |
| `TURN_URL`            | No       | Public TURN endpoint (UDP/TCP relay), e.g. `turn:turn.example.com:3478`.                           |
| `TURN_TLS_URL`        | No       | Public TURN-over-TLS endpoint, e.g. `turns:turn.example.com:5349`.                                 |
| `TURN_SHARED_SECRET`  | No\*     | Server-held secret for minting TURN credentials. Never sent to the client.                         |
| `TURN_REALM`          | No       | coturn `realm` directive. Set to your own domain; no default (empty falls back to coturn's).       |
| `TURN_EXTERNAL_IP`    | No       | Host's public IPv4 when ports are NAT-forwarded (docker behind NAT); maps to coturn `external-ip`. |
| `SKIP_ENV_VALIDATION` | No       | Skips env validation entirely. Used during the Docker build; unset at runtime.                     |

Client side (`packages/env/src/web.ts`): none. The client bakes no ICE
endpoints. STUN/TURN coordinates are fetched at runtime from `/ice-config`,
which mints per-request TURN credentials from the server-held
`TURN_SHARED_SECRET`.

Validation is skipped when `SKIP_ENV_VALIDATION` is set (the Dockerfile sets
it during the build phase, then unsets it). At runtime `NODE_ENV=production`
is expected and `CORS_ORIGIN` should be set to your deployed origin. If you
supply an `apps/web/.env` file, Compose loads it; otherwise export the
variables in your deployment environment.

\* `TURN_SHARED_SECRET` must match the value coturn is configured with
(passed to the `coturn` service through the same `apps/web/.env` file or a
compose `environment:` block). It is read server-side only — the
`/ice-config` route uses it to compute per-request HMAC-SHA1 credentials and
never serializes it into a response or log. The empty-or-set guard on the
coturn side lives in `deploy/coturn/entrypoint.sh`, which exits if the
secret is empty; the compose passthrough itself uses `${TURN_SHARED_SECRET:-}`
(empty default), not a required `${VAR:?}` form, which is what makes the
service deployable on Dokploy without a hard failure at interpolation time.

## 5. Logging and metadata posture

The broker keeps nothing. From the [threat model](../architecture/threat-model.md):

- The broker holds no persistent state, no presence table, and no message
  log.
- There are no application logs.
- "No persistence" means the application retains none; it does not mean
  observation is impossible.

While the broker process runs, signaling metadata — conversation IDs, client
IP addresses, connection timing — is observable by the hosting platform's
own layers (reverse-proxy access logs, load-balancer logs, container log
drivers, the network itself). The application cannot suppress those; the
operator must.

### What the operator must do

- Disable reverse-proxy access logs (or reduce them to the minimum the
  platform requires). nginx: `access_log off;`. Caddy: do not enable the
  access-log directive for the chat vhost. Traefik: set `accessLog` to a
  disabled or no-op config.
- Limit container log-driver retention. Docker: configure the `json-file`
  driver with `max-size` and `max-file`, or use a logless driver.
- Disable hosting-platform request logging where the platform exposes it
  (cloud-provider load balancers, CDN edge logs, and so on).

This is the operational side of the threat model's metadata section: a
stateless broker that retains nothing can still be observed while it runs.
The application's contribution to that surface is zero by construction; the
operator's contribution is a deployment choice.

## 6. NAT traversal

The bundled `coturn` service provides STUN and TURN. Practical consequences:

- Peer pairs behind cone NATs, restricted-cone NATs, and
  symmetric-vs-port-preserving NATs connect via server-reflexive candidates
  from STUN (`STUN_URL`).
- Peer pairs where at least one side is behind a symmetric NAT (roughly
  10–20% of home networks) connect via the TURN relay (`TURN_URL` over
  UDP/TCP, optionally `TURN_TLS_URL` over TLS). The relay is allocated out
  of the coturn `min-port`/`max-port` range, and its credentials are minted
  per session by `/ice-config` from the server-held `TURN_SHARED_SECRET`.
- When no path works (host, STUN, TURN), the user sees a connection error
  in the UI. The broker still relays nothing on the peers' behalf — once the
  data channel opens, TURN is only in the path if a relay is actually in
  use, and coturn keeps no persistent state about the session beyond the
  allocation.

Operators who do not set `STUN_URL` / `TURN_URL` / `TURN_SHARED_SECRET` get
the loopback/LAN behavior: `/ice-config` returns `{ iceServers: [] }`, the
browser gathers host candidates only, and peers on the same LAN or on
`localhost` connect directly. This is the CI path — no STUN/TURN is required
for the test suite.

## 7. No telemetry, analytics, or error reporting

The application contains no analytics, no error-reporting SDK, no telemetry,
and no data-exfiltration path. There is no Sentry, PostHog, Google Analytics
(`gtag`), Mixpanel, Datadog, or any other third-party observation SDK
imported by `apps/web/src` or any `packages/*` workspace.

The operator must not add such SDKs to a deployed build. Adding telemetry to
a build that runs in a user's browser reintroduces the disclosure surface
the application was built to avoid. If you need operational visibility,
instrument the infrastructure (proxy, load balancer, container runtime), not
the client.

## 8. Trust verification

These closure decisions are inherited by the deployment and verifiable from
source at any time.

- **No telemetry.** `grep -riE
"analytics|telemetry|sentry|gtag|posthog|mixpanel|datadog" apps/web/src
packages/` returns no matches. The deployment must not reintroduce any.
- **No server-side message-key or identity material in env config.**
  `packages/env/src/server.ts` defines `CORS_ORIGIN`, `NODE_ENV`,
  `PUBLIC_BASE_URL`, the public ICE endpoint URLs
  (`STUN_URL` / `TURN_URL` / `TURN_TLS_URL`), `TURN_REALM`, and
  `TURN_SHARED_SECRET`. There is no message-key config and no identity-key
  config. All cryptographic secrets protecting user content live in the
  user's browser (origin-scoped storage); none are sent to the server. The
  single server-held secret is `TURN_SHARED_SECRET`, used only to mint
  time-limited TURN credentials — it is never serialized into a response,
  never baked into the client bundle, and never written to logs.
- **Runtime config contains only public endpoint details plus one TURN
  minting secret.** The client derives its broker URL from
  `window.location`; the server inputs that reach the browser are the CORS
  origin, the node environment, the public base URL, and the ICE endpoint
  coordinates. `TURN_SHARED_SECRET` stays server-side; only the resulting
  ephemeral `username` / `credential` (valid for the TTL configured on
  `/ice-config`) reach the client.

Cryptography in a browser cannot protect users served a malicious build, nor
an endpoint controlled by malware or a privileged extension. Source
inspection alone does not prove the deployed bytes match source. Self-hosting
or independently verified / reproducible release artifacts are required for
users whose threat model includes a malicious operator; that remains outside
the implementation scope (see "Build and endpoint trust" in the threat
model).

## 9. Operator checklist

Before going live:

1. Stand up a reverse proxy (Caddy / nginx / Traefik, or Dokploy's built-in
   traefik) that terminates TLS on 443 and forwards `/ws` with the WebSocket
   upgrade headers to the service on port 9000 (`http://web:9000` on the
   compose network, or `127.0.0.1:9000` if the proxy is host-side). Do not
   publish the `web` container port on a host interface — the compose file
   uses `expose:`, not `ports:`.
2. If peers will be on the open internet, configure coturn in the same
   `docker compose up` deployment:
   - Generate a strong `TURN_SHARED_SECRET` and put it in `apps/web/.env`
     (used by both the `web` and `coturn` services).
   - Set `STUN_URL`, `TURN_URL` (and optionally `TURN_TLS_URL`) in
     `apps/web/.env` to the public host:port clients will reach coturn on
     (e.g. `stun:turn.example.com:3478`).
   - Publish the coturn ports on the host firewall: `3478/udp`, `3478/tcp`,
     `5349/tcp` (if using `turns:`), and the full relay range
     `49152-49172/udp`. These are already in `docker-compose.yml`'s `ports:`
     for the `coturn` service; confirm your host firewall and any cloud
     security group allow them.
3. Disable reverse-proxy access logs and cap container log retention.
4. Set `CORS_ORIGIN` to your deployed origin and `NODE_ENV=production`.
5. `docker compose up -d --build` and confirm both healthchecks return
   healthy (the `web` service probes `GET /`, the `coturn` service probes a
   TCP connect on 3478).
6. Verify the broker is reachable over WSS by opening the deployed app and
   creating an invitation; the broker must accept the `wss://<host>/ws`
   upgrade.
7. Verify `/ice-config` returns the expected servers (when configured):
   `curl https://<host>/ice-config` should return
   `{"iceServers":[{"urls":"stun:..."},...]}` with TURN entries carrying
   `username` and `credential`. When nothing is configured it returns
   `{"iceServers":[]}`.
8. Confirm no telemetry has been added to your build (the grep in §8 is
   empty).
