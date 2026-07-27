# Deployment Guide

This is the operator-facing deployment guide for `fuck-eu-chat-control`
v1. It documents the single-process deployment model, the ports and
TLS/WSS requirements, the runtime configuration surface, the logging
and metadata posture, and the known NAT limits. It is the counterpart
to the [threat model](../architecture/threat-model.md) and the
[frozen protocol](../architecture/protocol-v1.md); read those for the
security properties, not this file.

v1 ships with **no TURN relay** and **no in-image STUN listener**.
Loopback and LAN operation work without STUN; internet operation
requires the operator to run a standards-compliant STUN service and
point clients at it. Both are documented below.

## 1. The one-deploy model

The TanStack Start (Nitro) server is the only process. It serves:

- The SSR'd React application (HTML, JS, CSS, assets) over HTTPS.
- The signaling broker as a Nitro WebSocket route at `/ws`, on the
  **same port** as the app.

There is no separate broker host, no separate signaling service, and no
STUN listener bundled into the image. The broker is an in-process
Nitro WebSocket handler at `apps/web/src/server/broker.ts` that holds
**no persistent state**, **no presence table**, and **no application
logs**. Once a WebRTC data channel opens between two peers, both
disconnect from the broker and it leaves the data path entirely. (See
the threat model's "What the system protects" section.)

Because the broker is served from the same origin as the app, the
client derives its broker URL as `wss://<host>/ws` from
`window.location` at runtime (`apps/web/src/features/chat/runtime/chat-provider.tsx`,
`resolveBrowserDeps`). No broker URL is configured server-side.

### v1 has no STUN listener in the image

The Docker image runs only the Nitro server. It does **not** run a
STUN listener. The browser's WebRTC stack needs ICE candidates to
establish a P2P data channel:

- **Loopback (`localhost`) and same-LAN operation** works without a
  STUN server: the browser gathers host candidates from the local
  interfaces and a data channel connects directly.
- **Internet operation** (peers across different NATs) requires the
  operator to run a standards-compliant STUN service (for example
  [coturn](https://github.com/coturn/coturn)) on **UDP 3478**, and
  point the client at it. STUN is not bundled, not auto-configured,
  and not optional for internet deployment.

### Where ICE servers are configured

The ICE server list is currently a code-level constant in the client,
not an environment variable. In
`apps/web/src/features/chat/runtime/chat-provider.tsx`, the
`createChatController` call passes:

```ts
iceServers: [],
```

For a self-hosted internet deployment, the operator edits this list to
include their STUN server before building the image, for example:

```ts
iceServers: [{ urls: "stun:stun.example.com:3478" }],
```

There is no runtime environment variable for ICE servers in v1 (the
env surface is documented in §4). Operators who do not control their
build cannot change this without rebuilding. A future PRD may surface
ICE servers as a public env var; for v1, the build-time constant is
the honest answer.

## 2. Ports

| Port          | Protocol | Purpose                                                           | Required in v1?                              |
| ------------- | -------- | ----------------------------------------------------------------- | -------------------------------------------- |
| 443           | HTTPS    | App + broker `/ws` (WSS after the proxy upgrades the connection). | Yes.                                         |
| 3478          | UDP      | STUN (e.g. coturn).                                               | Only for internet/NAT traversal deployments. |

The app listens on **TCP 9000** inside the container
(`ENV PORT=9000` in `apps/web/Dockerfile`,
`ENV HOST=0.0.0.0`). The Docker Compose file uses `expose: ["9000"]`
(not `ports:`), so the service is reachable **only on the Docker
network** — Dokploy/traefik (or your reverse proxy) reaches it as
`http://web:9000` and never publishes it on a host interface. In
production, terminate TLS at a reverse proxy in front of the node
server and expose 443 to the internet; do not publish the container
port on a host interface.

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

| Variable              | Required | Purpose                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| `CORS_ORIGIN`         | Yes\*    | The origin allowed for CORS. Set to your deployed origin.                      |
| `NODE_ENV`            | Yes\*    | `production` (set in the Dockerfile).                                          |
| `SKIP_ENV_VALIDATION` | No       | Skips env validation entirely. Used during the Docker build; unset at runtime. |

\* Validation is skipped when `SKIP_ENV_VALIDATION` is set (the
Dockerfile sets it during the build phase, then unsets it). At runtime,
`CORS_ORIGIN` and `NODE_ENV=production` are expected. If you supply an
`apps/web/.env` file, Compose loads it; otherwise export the variables
in your deployment environment.

There is **no** server-side environment variable for STUN/TURN servers,
ICE configuration, message keys, identity material, or any secret. The
env surface is two public values. (See "Trust verification" below.)

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

## 6. NAT traversal and known limits

v1 is **STUN-only, no TURN**. Practical consequences:

- Peer pairs behind **cone NATs, restricted-cone NATs, and
  symmetric-vs-port-preserving NATs** typically connect via server-
  reflexive candidates from STUN.
- Peer pairs where **at least one side is behind a symmetric NAT**
  (roughly 10–20% of home networks) generally **cannot** establish a
  P2P data channel without a TURN relay. There is no TURN relay in v1
  and TURN is explicitly out of scope for v1.
- When a connection cannot be established, the user sees a connection
  error in the UI; the broker does not relay anything on the peers'
  behalf.

This is a known v1 limitation, surfaced honestly in the product UI and
here. Operators serving users on hostile NATs should plan for a future
TURN-bearing PRD, but must not assume TURN exists in v1.

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
- **No server-side message-key or secret material in env config.**
  `packages/env/src/server.ts` defines exactly two server variables:
  `CORS_ORIGIN` (a URL) and `NODE_ENV`. There is no message-key
  config, no identity-key config, and no secret material of any kind.
  All cryptographic secrets live in the user's browser
  (`localStorage`, origin-scoped); none are sent to the server.
- **Runtime config contains only public endpoint details.** The client
  derives its broker URL from `window.location`; the only runtime
  server inputs are the CORS origin and the node environment. ICE
  servers are a build-time code constant (§1), not a runtime secret.

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
   the proxy is host-side). Do NOT publish the container port on a host
   interface — the Compose file uses `expose:`, not `ports:`.
2. If peers will be on the open internet, run coturn (or equivalent)
   on UDP 3478, and edit `iceServers` in
   `apps/web/src/features/chat/runtime/chat-provider.tsx` to point at
   it before building.
3. Disable reverse-proxy access logs and cap container log retention.
4. Set `CORS_ORIGIN` to your deployed origin and `NODE_ENV=production`.
5. `docker compose up -d --build` and confirm the `/` healthcheck
   returns 200.
6. Verify the broker is reachable over WSS by opening the deployed
   app and creating an invitation; the broker must accept the
   `wss://<host>/ws` upgrade.
7. Confirm no telemetry has been added to your build (the grep in §8
   is empty).
