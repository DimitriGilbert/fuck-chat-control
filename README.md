# fuck-eu-chat-control

End-to-end encrypted peer-to-peer chat. No accounts. The server is only
involved until two browsers have found each other; once the WebRTC data
channel is open they talk directly and the server is out of the path.

It was written as a response to the EU "chat control" proposal, which would
require messaging services to scan private conversations. The design holds
no server-side keys and stores no messages, so there is nothing on the
server to scan and nothing to hand over under a scanning order.

The source is open at
[github.com/DimitriGilbert/fuck-chat-control](https://github.com/DimitriGilbert/fuck-chat-control).
You can read it, audit it, fork it, and host it yourself — which matters for
a tool whose security claims depend on the server not holding keys or
messages.

## Security model

Messages are encrypted under keys from an authenticated P-256 ECDH
handshake. The server relays signaling bytes and keeps no state. A peer is
authenticated one of two ways:

**Safety number (default).** Each chat shows a number derived from both
peers' identity keys. You read it to the other person through some other
channel — a call, in person, a different app. If it matches, nobody swapped
keys during the handshake. If you don't compare it, the messages are still
encrypted, but a server-side attacker could have substituted keys at setup
and neither of you would notice. That gap is the main one; the
[threat model](docs/architecture/threat-model.md) lays out the rest.

**6-digit code (optional, web and desktop).** Turn on "Protect with a
6-digit code" and a PAKE exchange (SPAKE2) is folded into the key
derivation. Without the code an attacker can't finish the handshake, so
comparing a safety number isn't needed — but you do have to get the code to
the other person some other way. The mobile app is safety-number-only: the
SPAKE2 wasm is not bundled on React Native, so the code option is not
offered there.

The broker holds no persistent state, no presence table, and no logs. When
the data channel opens, both peers disconnect from it. Received files live
in memory only; if you close the chat without saving them, they're gone.

**Status:** implemented. Two real browsers (chromium and firefox) connect,
finish the handshake, and exchange encrypted messages and files. The
sidebar keeps multiple chats open at once.

## Demo

Two isolated browser profiles connect over WebRTC, open a second chat to
show that conversations stay isolated, send a file end-to-end, and compare
a safety number. Recorded live at 1080p with captions baked in:

![Two-browser live chat demo](docs/media/chat-demo.gif)

The full-quality WebM is on the
[`demo-v1` release](https://github.com/DimitriGilbert/fuck-chat-control/releases/tag/demo-v1).

For the security properties and their exact boundaries, read the
[threat model](docs/architecture/threat-model.md) and the
[protocol spec](docs/architecture/protocol-v1.md). For deployment, read the
[deployment guide](docs/deployment/deployment.md).

## Stack

TypeScript monorepo with pnpm workspaces. The web app is TanStack Start on
Nitro — it serves the SSR React app and the broker WebSocket route (`/ws`)
from one process on one port. Styling is TailwindCSS with shared
`shadcn/ui` primitives in `packages/ui`. Tooling, lint, and format run
through Vite+. The crypto core lives in `packages/chat-runtime`: `@noble/curves`
for P-256 (ECDSA and ECDH), `hash-wasm` for Argon2id, and native WebCrypto
for AES-256-GCM, HKDF-SHA256, and SHA-256. SPAKE2 ships as a Rust crate
compiled to WASM. See [ADR 001](docs/adr/001-crypto-dependencies.md).

## Getting started

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3001>. Loopback and LAN work with no STUN;
cross-internet connections need a STUN/TURN service — see the deployment
guide.

## Tests

```bash
pnpm test:unit                                                       # vitest unit tests
pnpm --filter @fuck-eu-chat-control/chat-runtime test:integration     # broker, orchestrator, pake
pnpm test:e2e                                                        # playwright end-to-end
```

## Deployment

One process: the Nitro server serves the app and hosts the broker
WebSocket route.

```bash
docker compose up -d --build
```

Production needs a TLS-terminating reverse proxy in front that upgrades
`/ws` to WSS, plus — for internet peers — a STUN/TURN service (a coturn
container is bundled in the compose file). Ports, env vars, the logging
posture, and the operator checklist are in the
[deployment guide](docs/deployment/deployment.md).

## Project structure

```
fuck-chat-control/
├── apps/
│   ├── web/              # React + TanStack Start app + broker /ws route
│   ├── desktop/          # Tauri shell
│   └── mobile/           # Expo (React Native) shell
├── packages/
│   ├── chat-runtime/     # crypto, protocol codec, framing, orchestrator, runtime
│   ├── ui/               # shared shadcn/ui components and styles
│   ├── env/              # typed env
│   └── config/           # shared tsconfig base
└── docs/                 # architecture, adr, deployment
```

## UI customization

React apps share `shadcn/ui` primitives through `packages/ui`.

- Design tokens and global styles: `packages/ui/src/styles/globals.css`.
- Shared primitives: `packages/ui/src/components/*`.
- shadcn aliases and style config: `packages/ui/components.json` and
  `apps/web/components.json`.

Add shared primitives from the project root:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

```tsx
import { Button } from "@fuck-eu-chat-control/ui/components/button";
```

For app-specific blocks, run the shadcn CLI from `apps/web`.

## Scripts

- `pnpm dev` — start all apps in dev mode.
- `pnpm build` — build all apps.
- `pnpm check` — Vite+ format and lint checks plus workspace TypeScript.
- `pnpm check-types` — TypeScript types across all apps.
- `pnpm lint` / `pnpm format` — Vite+ lint / format.
- `pnpm test:unit` / `pnpm test:e2e` / `pnpm test` — unit, e2e, or both.
- `pnpm dev:web` / `dev:desktop` / `dev:mobile` — start one app.
- `pnpm docker:build` / `docker:up` / `docker:down` / `docker:logs` — Compose lifecycle.
- `pnpm hooks:setup` — install Vite+ native Git hooks.

## Git hooks and formatting

- Optional native Vite+ hooks: `pnpm hooks:setup`.
- Run checks: `pnpm check`.
- Vite+ commit hooks: <https://viteplus.dev/guide/commit-hooks>.
