# fuck-eu-chat-control

A serverless, no-account, end-to-end-encrypted peer-to-peer chat whose
server drops out of the data path after the handshake. Built as
concrete resistance to the EU "chat control" mass-scanning mandate:
there is no server-side key material, no message log, and nothing to
hand over. Once two peers complete the application handshake over the
broker, they exchange messages over a direct WebRTC data channel and
the broker leaves the path entirely.

The security model in one paragraph: messages are end-to-end encrypted
under keys derived from an authenticated P-256 ECDH handshake; the
broker only relays signaling bytes; identity is TOFU with a
per-conversation safety number that the two humans must compare over an
independent trusted channel (v1 has no PAKE and no six-digit code).
The server holds no persistent state, no presence table, and no
application logs. v1 is text-only chat; file transfer exists at the
protocol level but has no UI yet.

**Status:** v1 is implemented and tested — two real browsers (chromium +
firefox) connect, complete the authenticated handshake, and exchange
messages that match a shared safety number. 427 unit tests, 5 integration
tests (broker over a real dev server), and 24 end-to-end tests pass. v1 is
text-only; file transfer exists at the protocol/framing layer with no UI yet.

For the security properties and their precise boundaries, read
[`docs/architecture/threat-model.md`](docs/architecture/threat-model.md)
and [`docs/architecture/protocol-v1.md`](docs/architecture/protocol-v1.md).
For deployment, read
[`docs/deployment/deployment.md`](docs/deployment/deployment.md).

## Stack

- **TypeScript** across the workspace, with type safety enforced via `pnpm check`.
- **TanStack Start** (Nitro) — SSR React app and the in-process broker
  WebSocket route (`/ws`) on the same port.
- **TailwindCSS** + shared `shadcn/ui` primitives in `packages/ui`.
- **Vite+** — unified Vite toolchain, workspace task runner, linting,
  and formatting.
- Crypto: `@noble/curves` (P-256 ECDSA/ECDH), `hash-wasm` (Argon2id),
  and native WebCrypto for AES-256-GCM, HKDF-SHA256, and SHA-256. See
  [`docs/adr/001-crypto-dependencies.md`](docs/adr/001-crypto-dependencies.md).

## Getting started

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3001>. Loopback and LAN operation work without
STUN; cross-internet operation needs a STUN service — see the
deployment guide.

## Tests

```bash
pnpm test:unit                    # vitest unit tests
pnpm --filter web test:e2e        # playwright end-to-end
pnpm --filter web test:integration # vitest integration (broker/ws)
```

Or run everything for the web app with `pnpm --filter web test`.

## Deployment

The app is a single process: the Nitro server serves the app and hosts
the broker WebSocket route. Build and run with Docker Compose:

```bash
docker compose up -d --build
```

Production needs a TLS-terminating reverse proxy in front of node
(Caddy/nginx/Traefik) that upgrades `/ws` to WSS, and — for internet
peers — a STUN service on UDP 3478. v1 has no TURN relay; symmetric-NAT
peer pairs (~10–20%) cannot connect. Full details, ports, env vars,
logging posture, and the operator checklist are in
[`docs/deployment/deployment.md`](docs/deployment/deployment.md).

## UI customization

React web apps share `shadcn/ui` primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`.
- Update shared primitives in `packages/ui/src/components/*`.
- Adjust shadcn aliases or style config in `packages/ui/components.json`
  and `apps/web/components.json`.

Add shared primitives from the project root:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@fuck-eu-chat-control/ui/components/button";
```

For app-specific blocks, run the shadcn CLI from `apps/web`.

## Project structure

```
fuck-eu-chat-control/
├── apps/
│   └── web/         # Fullstack app (React + TanStack Start) + broker /ws route
├── packages/
│   ├── env/         # Typed env (CORS_ORIGIN, NODE_ENV only)
│   └── ui/          # Shared shadcn/ui components and styles
└── docs/
    ├── architecture/  # threat model, protocol v1, orchestrator, runtime
    ├── adr/           # architecture decisions
    └── deployment/    # operator deployment guide
```

## Available scripts

- `pnpm dev` — start all apps in development mode.
- `pnpm build` — build all apps.
- `pnpm check` — run Vite+ format/lint checks and workspace TypeScript checks (0 warnings required).
- `pnpm check-types` — TypeScript types across all apps.
- `pnpm lint` / `pnpm format` — Vite+ lint / format.
- `pnpm test:unit` — workspace unit tests.
- `pnpm test:e2e` — workspace E2E (Playwright).
- `pnpm test` — unit + E2E.
- `pnpm --filter web test:integration` — broker/WebSocket integration tests.
- `pnpm dev:web` — start only the web app.
- `pnpm staged` — run Vite+ checks against staged files.
- `pnpm hooks:setup` — install Vite+ native Git hooks via `vp config`.
- `pnpm docker:build` / `docker:up` / `docker:logs` / `docker:down` — Docker Compose lifecycle.

## Git hooks and formatting

- Optional native Vite+ hooks: `pnpm hooks:setup`.
- Run checks: `pnpm check`.
- Vite+ commit hooks docs: <https://viteplus.dev/guide/commit-hooks>.
