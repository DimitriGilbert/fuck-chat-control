# Deployment Guide

This is the operator-facing deployment guide for `fuck-eu-chat-control`
v1. It documents the single-process deployment model, the ports and
TLS/WSS requirements, the runtime configuration surface, the logging
and metadata posture, and the known NAT limits. It is the counterpart
to the [threat model](../architecture/threat-model.md) and the
[frozen protocol](../architecture/protocol-v1.md); read those for the
security properties, not this file.

v1 ships STUN and TURN via a bundled coturn service in
`docker-compose.yml`, with credentials minted per-request by the Nitro
server from a shared secret that never leaves the server. Loopback and
LAN operation still work with nothing configured; internet operation
requires the operator to publish the coturn ports and set the
endpoint env vars documented below.

## 1. The one-deploy model

The TanStack Start (Nitro) server is the only process the chat
application needs. It serves:

- The SSR'd React application (HTML, JS, CSS, assets) over HTTPS.
- The signaling broker as a Nitro WebSocket route at `/ws`, on the
  **same port** as the app.
- The ICE config route at `GET /ice-config`, which returns the public
  STUN/TURN endpoints plus a freshly minted, time-limited TURN
  credential pair. The shared secret used to mint those credentials is
  read from `TURN_SHARED_SECRET` and **never** sent to the client (see
  §4 and §8).

There is no separate broker host and no separate signaling service.
The broker is an in-process Nitro WebSocket handler at
`apps/web/src/server/broker.ts` that holds **no persistent state**,
**no presence table**, and **no application logs**. Once a WebRTC data
channel opens between two peers, both disconnect from the broker and
it leaves the data path entirely. (See the threat model's "What the
system protects" section.)

A separate `coturn` container (STUN + TURN relay) is defined in
`docker-compose.yml` alongside `web`. Unlike `web` (which is HTTP
behind traefik and uses `expose:`), coturn speaks UDP and **must** be
published on the host via `ports:` — an HTTP reverse proxy cannot
relay TURN traffic. See §2 and §6 for the port list.

Because the broker is served from the same origin as the app, the
client derives its broker URL as `wss://<host>/ws` from
`window.location` at runtime (`apps/web/src/features/chat/runtime/chat-provider.tsx`,
`resolveBrowserDeps`). No broker URL is configured server-side.

### ICE configuration: where it lives

The ICE server list is **runtime env config, not a build-time
constant**. The browser fetches `GET /ice-config` at boot (same
origin, relative URL) and passes the result into `createChatController`:

```ts
const instance = createChatController({
  // ...
  iceServers, // fetched from /ice-config, falls back to [] on failure
});
```

The route (`apps/web/src/server/ice-config.ts`) builds the list from
server-side env (`STUN_URL`, `TURN_URL`, `TURN_TLS_URL`) and, for TURN
entries, mints a fresh HMAC-SHA1 long-term credential per request
using the TURN REST API ("time-limited credentials"):

- `username = "<unix-expiry-seconds>:fck-web"`
- `credential = base64( HMAC-SHA1(TURN_SHARED_SECRET, username) )`
- credential TTL is 6 hours; the route sets `Cache-Control: public,
max-age=3600` so the browser re-fetches comfortably before expiry.

The shared secret (`TURN_SHARED_SECRET`) is read from env and used
**only** to compute the credential — it is never serialized into any
response, never baked into the client bundle, and never written to
logs. Only the resulting ephemeral `username`/`credential` reach the
browser. This is consistent with §8 ("runtime config contains only
public endpoint details").

When nothing is configured (loopback / LAN / CI), `/ice-config`
returns `{ iceServers: [] }` and the client falls back to host
candidates — which is what makes `localhost`-to-`localhost`
connections work without any STUN/TURN infra. A fetch failure is also
swallowed and falls back to `[]`, so the chat UI never blocks on ICE
config.

## 2. Ports

| Port        | Protocol | Purpose                                                             | Required in v1?                                  |
| ----------- | -------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| 443         | HTTPS    | App + broker `/ws` + `/ice-config` (WSS after the proxy upgrades).  | Yes.                                             |
| 3478        | UDP      | STUN + TURN relay (coturn).                                         | Yes for cross-network P2P; optional for LAN.     |
| 3478        | TCP      | TURN relay, TCP fallback for UDP-blocking networks.                 | Recommended; needed on UDP-blocking networks.    |
| 5349        | TCP      | TURN over TLS (`turns:`).                                           | Optional; requires cert/pkey mounted in coturn.  |
| 49152-49172 | UDP      | TURN relay allocation range (matches coturn `min-port`/`max-port`). | Yes when TURN is enabled; widen for more relays. |

The `web` service listens on **TCP 9000** inside the container
(`ENV PORT=9000` in `apps/web/Dockerfile`,
`ENV HOST=0.0.0.0`). The Docker Compose file uses `expose: ["9000"]`
(not `ports:`) for `web`, so the service is reachable **only on the
Docker network** — Dokploy/traefik (or your reverse proxy) reaches it
as `http://web:9000` and never publishes it on a host interface. In
production, terminate TLS at a reverse proxy in front of the node
server and expose 443 to the internet; do not publish the `web`
container port on a host interface.

The `coturn` service is the exception: it uses `ports:` and is
published on the host, because STUN/TURN speak UDP and cannot be
proxied by an HTTP reverse proxy. Operators MUST publish 3478/udp,
3478/tcp, 5349/tcp (if using `turns:`), and the full relay range
49152-49172/udp on the host firewall. coturn reads its config from
`deploy/coturn/turnserver.conf` (mounted read-only) and expands
`$TURN_SHARED_SECRET`/`$TURN_REALM` from the environment at startup.

The `/ws` route MUST be reached over **WSS** (secure WebSocket) in
production. A plain-WS broker reachable over HTTP is not acceptable:
the signaling channel carries invitation-bearing rendezvous messages,
and the threat model's guarantees assume TLS/WSS-encrypted signaling.
The client derives `wss://` from `window.location` when the app is
served over HTTPS, so this happens automatically as long as the proxy
terminates TLS correctly.

### Reverse-proxy WebSocket upgrade

The proxy in front of the node server MUST forward the WebSocket
upgrade headers for `/ws`. Otherwise the broker handshake fails and
peers cannot rendezvous.

nginx example:

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

Caddy example (automatic HTTPS + WebSocket pass-through by default):

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:9000
}
```

Traefik example (YAML):

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

> On Dokploy (and any Docker network setup), point the proxy at the
> service name on the compose network — `http://web:9000` — rather than
> `127.0.0.1:9000`. The `127.0.0.1` form above applies only when the
> proxy runs on the host alongside the container.

The app does not validate `X-Forwarded-Proto` directly; it uses
`window.location.protocol`, so the proxy's TLS termination is what
makes the client pick `wss://`.

## 3. TLS / WSS

Terminate TLS at the reverse proxy (Caddy, nginx, Traefik, or the
hosting platform's HTTPS layer) in front of the node server. The node
process itself speaks HTTP on port 9000 inside the container; it does not present
certificates.

- The app's broker URL is derived as
  `${protocol === "https:" ? "wss" : "ws"}://${host}/ws` from
  `window.location`, so when the proxy serves the app over HTTPS the
  broker URL is automatically `wss://`.
- The conversation ID is carried in the URL **fragment**, which
  browsers never send to the server in an HTTP request. TLS still
  protects the rest of the URL and the signaling payloads in transit.

## 4. Docker

Build and run from the repository root:

```bash
docker compose up -d --build
```

This builds `apps/web/Dockerfile` (node:24, builds the SSR bundle via
`pnpm run build`, runs `.output/server/index.mjs`) and starts it with
the healthcheck below. The Compose file uses `expose: ["9000"]` (the
service is reachable on the Docker network only, not published on a
host interface) and sets `restart: unless-stopped`.

### Health check

The Compose healthcheck hits `http://localhost:9000/` (using the
container's `PORT` env) every 10 s and
expects a 2xx. The `/` GET is the health endpoint: it returns the SSR'd
landing page with HTTP 200 and produces **no application-level chat or
broker logs**. There is no separate `/healthz`; `/` is it.

### Production environment variables

The server env surface is intentionally tiny. From
`packages/env/src/server.ts`:

| Variable              | Required | Purpose                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `CORS_ORIGIN`         | Yes\*    | The origin allowed for CORS. Set to your deployed origin.                                        |
| `NODE_ENV`            | Yes\*    | `production` (set in the Dockerfile).                                                            |
| `STUN_URL`            | No       | Public STUN endpoint, e.g. `stun:turn.example.com:3478`. Served to the client via `/ice-config`. |
| `TURN_URL`            | No       | Public TURN endpoint (UDP/TCP relay), e.g. `turn:turn.example.com:3478`.                         |
| `TURN_TLS_URL`        | No       | Public TURN-over-TLS endpoint, e.g. `turns:turn.example.com:5349`.                               |
| `TURN_SHARED_SECRET`  | No\*\*   | Server-held secret for minting TURN credentials. **Never sent to the client.**                   |
| `TURN_REALM`          | No       | coturn `realm` directive; defaults to `turn.fuck-chat-control.eu`.                               |
| `SKIP_ENV_VALIDATION` | No       | Skips env validation entirely. Used during the Docker build; unset at runtime.                   |

Client-side (browser bundle, `packages/env/src/web.ts`): **none.** The
client bakes no ICE endpoints. STUN/TURN coordinates are fetched at runtime
from `/ice-config` (the single source), which mints per-request TURN
credentials from the server-held `TURN_SHARED_SECRET`.

\* Validation is skipped when `SKIP_ENV_VALIDATION` is set (the
Dockerfile sets it during the build phase, then unsets it). At runtime,
`CORS_ORIGIN` and `NODE_ENV=production` are expected. If you supply an
`apps/web/.env` file, Compose loads it; otherwise export the variables
in your deployment environment.

\*\* `TURN_SHARED_SECRET` MUST match the value coturn is configured
with (passed to the `coturn` service via the same `apps/web/.env` file
or compose `environment:`). It is read server-side only — the
`/ice-config` route uses it to compute per-request HMAC-SHA1
credentials and never serializes it into any response or log. The
client carries no static ICE coordinates in its bundle; it receives
the PUBLIC STUN/TURN endpoints (and per-request credentials) at runtime
from `/ice-config`. (See "Trust verification" below.)

## 5. Logging and metadata posture

The broker deliberately retains nothing. From the
[threat model](../architecture/threat-model.md):

- The broker holds **no persistent state**, **no presence table**, and
  **no message log**.
- There are **no application logs**.
- "No persistence" means the application retains none; it does **not**
  mean observation is impossible.

While the broker process is running, signaling metadata — conversation
IDs, client IP addresses, and connection timing — is observable by
the hosting platform's own layers (reverse proxy access logs, load
balancer logs, container log drivers, the network itself). The
application cannot suppress those; the operator must.

### What the operator MUST do

- **Disable reverse-proxy access logs** (or reduce them to the minimum
  the platform requires). nginx: `access_log off;`. Caddy: do not
  enable the access-log directive for the chat vhost. Traefik: set
  `accessLog` to a disabled/no-op config.
- **Limit container log driver retention**. Docker: configure the
  `json-file` driver with `max-size` and `max-file`, or use a
  logless driver (`local` with capped retention, or pipe to a
  sink that discards signaling-relevant lines).
- **Disable hosting-platform request logging** where the platform
  exposes it (cloud provider load balancers, CDN edge logs, etc.).

This is the operational side of the threat model's "irreducible
metadata" section: even a stateless broker that retains nothing can be
observed while it runs. The application's contribution to that surface
is zero by construction; the operator's contribution is a deployment
choice.

## 6. NAT traversal

v1 ships **STUN + TURN** via the bundled `coturn` service in
`docker-compose.yml`. Practical consequences:

- Peer pairs behind **cone NATs, restricted-cone NATs, and
  symmetric-vs-port-preserving NATs** connect via server-reflexive
  candidates from STUN (`STUN_URL`).
- Peer pairs where **at least one side is behind a symmetric NAT**
  (roughly 10–20% of home networks) connect via the **TURN relay**
  (`TURN_URL` over UDP/TCP, optionally `TURN_TLS_URL` over TLS). The
  relay is allocated out of the coturn `min-port`/`max-port` range and
  its credentials are minted per-session by `/ice-config` from the
  server-held `TURN_SHARED_SECRET`.
- When a connection cannot be established on any path (host, STUN,
  TURN), the user sees a connection error in the UI. The broker still
  relays nothing on the peers' behalf — once the data channel opens,
  TURN is only in the path if relay is actually in use, and coturn
  holds no persistent state about the session beyond the allocation.

Operators who do not configure `STUN_URL`/`TURN_URL`/`TURN_SHARED_SECRET`
get the prior loopback/LAN behavior: `/ice-config` returns
`{ iceServers: [] }`, the browser gathers host candidates only, and
peers on the same LAN or on `localhost` connect directly. This is the
CI path — no STUN/TURN is required for the test suite.

## 7. No telemetry, analytics, or error reporting

The application contains **no analytics, no error-reporting SDK, no
telemetry, and no data-exfiltration path**. There is no Sentry,
PostHog, Google Analytics (`gtag`), Mixpanel, Datadog, or any other
third-party observation SDK imported by `apps/web/src` or any
`packages/*` workspace.

The operator MUST NOT add such SDKs to a deployed build. Adding
telemetry to a build that runs in a user's browser reintroduces exactly
the disclosure surface the application was designed to avoid. If you
need operational visibility, instrument the infrastructure (proxy,
load balancer, container runtime), not the client.

## 8. Trust verification

These are the v1 closure decisions the deployment inherits. They are
verifiable from source at any time.

- **No telemetry.** `grep -riE
"analytics|telemetry|sentry|gtag|posthog|mixpanel|datadog" apps/web/src
packages/` returns no matches. The deployment must not reintroduce
  any.
- **No server-side message-key or identity material in env config.**
  `packages/env/src/server.ts` defines exactly these server variables:
  `CORS_ORIGIN` (a URL), `NODE_ENV`, the public ICE endpoint URLs
  (`STUN_URL`/`TURN_URL`/`TURN_TLS_URL`), `TURN_REALM`, and
  `TURN_SHARED_SECRET`. There is **no message-key config and no
  identity-key config**. All cryptographic secrets protecting user
  content live in the user's browser (`localStorage`, origin-scoped);
  none are sent to the server. The single server-held secret is
  `TURN_SHARED_SECRET`, used solely to mint time-limited TURN
  credentials — it is never serialized into any response, never baked
  into the client bundle, and never written to logs.
- **Runtime config contains only public endpoint details (+ one TURN
  minting secret).** The client derives its broker URL from
  `window.location`; the runtime server inputs that reach the browser
  are the CORS origin, the node environment, and the ICE endpoint
  coordinates. `TURN_SHARED_SECRET` stays server-side; only the
  resulting ephemeral `username`/`credential` (valid for the TTL
  configured on `/ice-config`) reach the client.

Cryptography in a browser cannot protect users served a malicious
build, nor an endpoint controlled by malware or a privileged
extension. Source inspection alone does not prove the deployed bytes
match source. Self-hosting or independently verified / reproducible
release artifacts are required for users whose threat model includes
a malicious operator; that remains outside v1 implementation scope
(see the threat model's "Build and endpoint trust" section).

## 9. Operator checklist

Before going live:

1. Stand up a reverse proxy (Caddy / nginx / Traefik, or Dokploy's
   built-in traefik) that terminates TLS on 443 and forwards `/ws`
   with the WebSocket upgrade headers to the service on port **9000**
   (`http://web:9000` on the compose network, or `127.0.0.1:9000` if
   the proxy is host-side). Do NOT publish the `web` container port on
   a host interface — the Compose file uses `expose:`, not `ports:`.
2. If peers will be on the open internet, configure coturn in the
   same `docker compose up` deployment:
   - Generate a strong `TURN_SHARED_SECRET` and put it in
     `apps/web/.env` (used by BOTH the `web` and `coturn` services).
   - Set `STUN_URL`, `TURN_URL` (and optionally `TURN_TLS_URL`) in
     `apps/web/.env` to the public host:port clients will reach coturn
     on (e.g. `stun:turn.example.com:3478`).
   - Publish the coturn ports on the host firewall: `3478/udp`,
     `3478/tcp`, `5349/tcp` (if using `turns:`), and the full relay
     range `49152-49172/udp`. These are already in `docker-compose.yml`'s
     `ports:` for the `coturn` service; confirm your host firewall
     and any cloud security group allow them.
3. Disable reverse-proxy access logs and cap container log retention.
4. Set `CORS_ORIGIN` to your deployed origin and `NODE_ENV=production`.
5. `docker compose up -d --build` and confirm both healthchecks return
   200/healthy (the `web` service probes `GET /`, the `coturn` service
   probes a TCP connect on 3478).
6. Verify the broker is reachable over WSS by opening the deployed
   app and creating an invitation; the broker must accept the
   `wss://<host>/ws` upgrade.
7. Verify `/ice-config` returns the expected servers (when configured):
   `curl https://<host>/ice-config` should return
   `{"iceServers":[{"urls":"stun:..."},...]}` with TURN entries
   carrying `username`/`credential`. When nothing is configured it
   returns `{"iceServers":[]}`.
8. Confirm no telemetry has been added to your build (the grep in §8
   is empty).
