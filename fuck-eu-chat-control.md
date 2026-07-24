# PRD: Serverless E2E-Encrypted P2P Chat (Fuck EU Chat Control)

## Problem Statement

People need to have private conversations without trusting a central server, an account provider, or a service operator with the content of their messages — and without leaving persistent server-side logs behind. Existing chat apps either (a) require accounts that tie identity to message history, (b) store messages server-side where they can be subpoenaed, logged, or scanned, or (c) operate as black boxes where the user cannot verify the encryption actually protects them end-to-end.

We want a chat where the server's role is reduced to the absolute minimum physics allows: briefly introducing two peers and providing their public NAT mappings so they can open a direct encrypted tunnel, then getting out of the way entirely. No accounts. No message storage on the server. No server-side logs. No identity at the server layer. The broker and STUN listener are operated by this deployment, never a third party. Once two peers are connected, the server is no longer in the data path and can go offline without affecting the conversation.

The threat model is honest: a malicious broker could attempt to man-in-the-middle the signaling exchange. We defeat this with an application-layer cryptographic key exchange performed over the already-DTLS-encrypted WebRTC data channel, authenticated either by a user-compared safety number or, optionally, by a short code carried in the invitation link that authenticates the exchange via PAKE. The broker is never trusted with keys or content.

Messages persist on the user's own device, encrypted at rest — never on any server. History is retained across sessions so conversations are resumable: the original invitation link works forever, and when both parties rejoin the broker room for that conversation, the connection re-establishes automatically. No presence system exists; "who is online" is an emergent property of two peers currently being in the same broker room, not tracked state.

The name is a pointed one: the design exists precisely because any "chat control" mandate that requires server-side scanning of message content is structurally impossible against a system whose server never sees content, never stores content, and drops out of the data path after handshake.

## Solution

A web-based, no-account, serverless (in steady state) end-to-end-encrypted chat application. A user opens the app, generates an invitation link, and shares it. The recipient opens the link. A stateless signaling broker relays the WebRTC SDP offer/answer and ICE candidates between the two peers. The same operator-controlled deployment exposes a STUN listener so clients can discover public NAT mappings; it is not a third-party service and it has no room, conversation, identity, or application-message protocol. Once the WebRTC data channel opens, both peers disconnect from the broker and the conversation continues purely peer-to-peer.

### Cryptographic layers

On top of the WebRTC DTLS-SRTP transport, two layers of keys are used:

**Persistent identity keys.** Each device generates, on first run, an ECDSA P-256 identity key pair that is stored locally and persists across sessions. This key signs the ephemeral session keys of every connection originating from this device, so a peer can verify that the person rejoining a conversation is the same person they spoke to before (TOFU — trust on first use). The identity key never touches the broker.

**Ephemeral session keys.** Every connection — whether the first or a resumption — uses fresh ECDH P-256 key pairs generated for that session only. Public keys are exchanged in-band over the data channel. An ECDH-derived shared secret is expanded via HKDF-SHA256 into a per-session AES-256-GCM key. This gives forward secrecy across sessions: compromising one session's keys does not expose any other session's messages, past or future. Each message is signed by the sender's persistent identity key, binding it to the peer's verified identity rather than just to the session.

### Authentication

A per-conversation safety number — `Truncate(SHA-256(conversationId || sort(A_idpub, B_idpub)), 40 bits)` displayed as grouped digits — is shown to both users for optional out-of-band verification. It is evidence only after the users compare it through an independent channel; the app labels it unverified until then. For cryptographic (not just human) resistance to an active MITM on the broker, an optional short code may be appended to the invitation link (in the URL fragment, so it never reaches the broker). After the data channel opens, both peers run SPAKE2 PAKE using the code and bind its result to the complete application handshake transcript. PAKE failure aborts loudly — no silent fallback to unauthenticated mode.

### Resumable conversations

The invitation link is stable: the conversation ID embedded in it never changes. To resume a conversation, either party simply opens the link again (or selects the conversation from their local conversation list). Their client rejoins the broker room for that conversation ID and waits. When the other party does the same, the broker sees two peers in the room and triggers the normal SDP/ICE exchange — the same signaling flow used for first contact. No presence system exists; there is no "online/offline" table at the broker. The broker holds an in-memory mapping of currently-connected peers to rooms, which evaporates on restart or when both peers disconnect. Conversation history (text only) is stored locally on each device, encrypted at rest, so reopening a conversation shows prior context immediately.

### At-rest encryption

Persisted history is encrypted before being written to the local store. The default mode generates a random AES-256 key via WebCrypto and stores it locally; all persisted messages are encrypted with this key before being written to the SQLite WASM database. An optional passphrase mode wraps the key via Argon2 (key derivation), raising the bar against an attacker with browser-profile access. The auto-key is extractable (stored as raw key material) specifically to enable an export/import bundle for multi-device transfer. Clearing browser site data destroys the key and renders persisted ciphertext unrecoverable; this trade-off is surfaced clearly in the UI.

### Multi-device via export/import

A user may export an encrypted bundle containing their identity key and full conversation history, wrapped by a passphrase they choose at export time. The bundle is a file the user moves themselves (USB, their own cloud, any channel they trust). Importing on a second device restores identity and history. No broker involvement in the transfer. (A future sync backend — self-hosted or SaaS — is an out-of-scope upgrade path that the architecture leaves room for.)

### v1 scope

V1 supports text messages and file/media transfer (files and media are ephemeral: received in the moment, must be saved explicitly or are lost when the conversation view closes; only text is persisted). Exactly two participants per conversation. Pure P2P via STUN only — no TURN relay. The trade-off is that peer pairs behind symmetric NAT will fail to connect (~10–20% of cases); this is documented and accepted for v1.

## User Stories

### First run and identity

1. As a user, I want to open the app in a browser with no login or account, so that I can start a private conversation immediately without surrendering identity.
2. As a first-time user, I want the app to generate a persistent device identity key automatically and silently, so that I can be recognized by peers across conversations without managing keys myself.
3. As a user, I want my identity key to never leave my device or be transmitted to any server, so that my identity cannot be correlated or logged at the server layer.
4. As a user, I want to be able to inspect my identity key fingerprint, so that I can verify it out-of-band if I choose.

### Starting a conversation

5. As a user, I want to click "Start conversation" and receive a shareable invitation link, so that I can invite someone to talk.
6. As a user, I want the invitation link to be short enough to paste into any messaging app, so that I can share it through whatever channel I already trust.
7. As a user, I want the app to generate a fresh, random conversation identifier for each new conversation, so that conversations cannot be correlated to one another by the broker.
8. As a user, I want the invitation link to contain only the conversation identifier and an optional verification code in the URL fragment, so that neither value is sent in the initial HTTP request or app-server access logs.
9. As a user, I want the option to add a short verification code to the invitation link, so that the key exchange is cryptographically authenticated against a malicious broker via PAKE.
10. As a user, I want to be able to omit the verification code, so that the link alone is sufficient to start a conversation when I am willing to rely on safety-number verification instead.
11. As a user, I want the app to show me a "waiting for peer" state after I create a conversation, so that I know my invitation is ready to be shared and the app is listening for a joiner.
12. As a user, I want the app to notify me audibly and visually when my peer joins, so that I am not staring at a waiting screen.

### Joining a conversation

13. As a participant, I want to open an invitation link and have the app load automatically, so that I can join a conversation with a single click.
14. As a participant, I want the app to read the conversation identifier from the link and connect to the broker on my behalf, so that I do not have to configure anything manually.
15. As a participant, I want the app to detect a verification code in the link fragment and use it to authenticate the key exchange via PAKE, so that I am protected against a man-in-the-middle on the broker without any extra steps.
16. As a participant, I want to see a "connecting" state while the WebRTC handshake proceeds, so that I have feedback that something is happening.
17. As a participant, I want to see a "connected" state once the data channel opens, so that I know I can start sending messages.
18. As a participant, I want to be informed clearly if the connection fails (e.g. due to NAT incompatibility), so that I understand why the conversation did not start rather than waiting forever.

### Resuming a conversation

19. As a user, I want my conversation list to show prior conversations, so that I can pick one back up without re-sharing or finding the old link.
20. As a user, I want the invitation link to remain valid forever, so that I can resume a conversation by simply opening the link again.
21. As a user, I want to open a prior conversation and have the client rejoin the broker room automatically, so that reconnection requires no manual steps.
22. As a user, I want to see my prior text history when I reopen a conversation, so that I have context for what was said before.
23. As a user, I want to see a "waiting for peer to rejoin" state when I open a conversation that the other party is not currently in, so that I know I need to wait or notify them out-of-band.
24. As a user, I want my peer's identity key to be checked against the one stored from our prior conversation, so that a different person rejoining the same conversation ID is flagged as a possible impersonation.
25. As a user, I want each reconnection to use fresh ephemeral session keys signed by the persistent identity key, so that compromise of one session does not compromise any other.
26. As a user, I want reconnection to feel instant when both parties rejoin, so that resuming is not a chore.

### Link sharing and ergonomics

27. As a user, I want a "copy link" button next to my invitation, so that I can share it without manually selecting the URL bar.
28. As a user, I want a QR code rendering of the invitation link, so that I can transfer it to a mobile device by camera without typing.
29. As a user, I want the verification code, when present, to be human-friendly (e.g. 6 digits), so that I can also speak it aloud to my peer as a secondary channel.

### Authentication and verification

30. As a user, I want both peers' clients to compute and display a safety number after the key exchange completes, so that I can optionally verify out-of-band that no man-in-the-middle occurred.
31. As a user, I want the safety number to be displayed as a short, readable sequence (e.g. 12 digits grouped in pairs), so that it is easy to compare verbally.
32. As a user, I want the safety number to match on both peers' screens when no MITM is present, so that a matching number gives me confidence in the channel.
33. As a user, I want the app to label a safety number as unverified until I compare it out-of-band, so that I understand that a mismatch can be detected only by the people doing that comparison.
34. As a user, I want the PAKE code exchange to fail loudly if the codes do not match, so that a tampered link cannot silently downgrade me to an unauthenticated session.
35. As a user, I want to be able to dismiss the safety-number dialog and continue chatting, so that verification is opt-in and does not block communication.
36. As a user, I want the app to never silently trust the broker's relayed SDP fingerprints, so that a substituted fingerprint is caught by the application-layer key exchange.

### Text messaging

37. As a user, I want to type a text message and press Enter to send it, so that I can chat fluidly.
38. As a user, I want Shift+Enter to insert a newline, so that I can compose multi-line messages.
39. As a user, I want my sent messages to appear immediately in the conversation view, so that I get instant feedback.
40. As a user, I want received messages to appear in order, so that the conversation reads naturally.
41. As a user, I want each message to show a sender indicator (me vs. peer), so that I can tell who said what.
42. As a user, I want timestamps on each message, so that I have context for when things were said.
43. As a user, I want messages to be encrypted with a per-session key derived from the ephemeral ECDH exchange, so that the broker and any network observer see only ciphertext.
44. As a user, I want each message to be signed by the sender's persistent identity key, so that tampering with message content is detectable and the sender is bound to their identity.
45. As a user, I want the app to reject messages whose signature does not verify, so that a forged or replayed message cannot be injected.
46. As a user, I want message nonces to be unique and checked, so that replayed ciphertext is rejected.

### File and media transfer

47. As a user, I want to attach a file by drag-and-drop or file picker, so that I can send arbitrary files to my peer.
48. As a user, I want large files to be sent in chunks over the data channel, so that I am not limited by message-size constraints.
49. As a user, I want a progress indicator while a file is sending, so that I can see how far along the transfer is.
50. As a user, I want a progress indicator while a file is receiving, so that I can see how far along the download is.
51. As a user, I want to cancel an in-progress file transfer, so that I can abort a mistaken send.
52. As a user, I want received files to be downloadable via a save link, so that I can keep them on my device.
53. As a user, I want each file chunk to be individually encrypted and authenticated, so that a tampered chunk is detected and rejected rather than corrupting the whole file.
54. As a user, I want a file manifest (name, size, type, hash) to be sent before the chunks, so that the receiver can prepare and verify the reassembled file.
55. As a user, I want the receiver to verify the reassembled file against the manifest hash, so that a truncated or corrupted file is flagged.
56. As a user, I want file transfers to survive brief data-channel congestion by applying backpressure, so that a large file does not starve text messages.
57. As a user, I want to be warned that files and media are not persisted and will be lost when the conversation view closes unless I save them, so that I do not lose data by accident.

### At-rest storage and history

58. As a user, I want my text history to persist locally on my device, so that I can read past conversations when I reopen them.
59. As a user, I want my persisted history encrypted at rest with a locally stored key, so that copied database material without the browser-origin key material does not expose my messages.
60. As a user, I want to opt into passphrase protection, so that my at-rest key is wrapped by a passphrase I choose and a browser-profile compromise still cannot decrypt my history.
61. As a user, I want to set or change my passphrase, so that I can raise my protection level at any time.
62. As a user, I want to be clearly warned that clearing browser site data will destroy my key and render my history unrecoverable, so that I do not lose data by accident.
63. As a user, I want to manually clear the history of a specific conversation, so that I can remove sensitive content on my own terms.
64. As a user, I want to manually clear all history, so that I can wipe the device of all conversation data.
65. As a user, I want only text to be persisted, so that large media does not bloat my local database.
66. As a user, I want files and media to be explicitly saved out (download) if I want to keep them, so that the local database stays small and my history stays text-only.

### Export and import

67. As a user, I want to export my identity and full conversation history as an encrypted bundle, so that I can move to another device.
68. As a user, I want to choose a passphrase at export time that encrypts the bundle, so that the bundle is safe to move through any channel (USB, my own cloud).
69. As a user, I want to import a bundle on a new device, so that my identity and history are restored.
70. As a user, I want import to merge or replace cleanly, so that I do not end up with duplicate or corrupted history.
71. As a user, I want the export bundle to be a single file, so that it is easy to handle and move.

### Connection lifecycle

72. As a user, I want my client to disconnect from the broker the moment the data channel opens, so that the broker holds no state about my conversation beyond the handshake.
73. As a user, I want the conversation to continue uninterrupted if the broker goes offline after handshake, so that I am not dependent on the broker's uptime for an ongoing chat.
74. As a user, I want a dropped P2P connection to be reported clearly, so that I know my peer is unreachable rather than guessing.
75. As a user, I want the option to attempt reconnection after a drop, so that a flaky network does not end the conversation permanently.
76. As a user, I want reconnection to use the broker again for re-signaling, so that a new P2P path can be established without manual intervention.
77. As a user, I want a "leave conversation" button that cleanly tears down the data channel, so that I can end the chat on my own terms.

### Privacy and security properties

78. As a user, I want the broker to never see the content of any message, so that it cannot log, scan, or be compelled to produce message content.
79. As a user, I want the broker to never see any encryption key, so that even a fully compromised broker cannot decrypt past or future traffic.
80. As a user, I want the broker to hold no persistent state, so that a subpoena served after the conversation yields nothing.
81. As a user, I want the broker to hold no presence table, so that who is online when is not recorded or observable.
82. As a user, I want each session to use fresh ephemeral keys signed by my persistent identity, so that compromise of one session does not compromise another.
83. As a user, I want the verification code, when used, to never be transmitted to the broker, so that the PAKE secret stays between the two peers.
84. As a user, I want the app to run entirely client-side with no backend code beyond the broker, so that the attack surface is minimal and auditable.
85. As a user, I want the app's source to be inspectable, so that I can verify the security claims rather than taking them on faith.
86. As a user, I want no telemetry, analytics, or error reporting that exfiltrates data, so that my usage is not observed by the app vendor.

### Error handling

87. As a user, I want a clear error if my peer never joins within a timeout, so that I am not left waiting indefinitely.
88. As a user, I want a clear error if the WebRTC handshake fails due to NAT incompatibility, so that I understand the connection is impossible rather than slow.
89. As a user, I want a clear error if the PAKE code on my link does not match my peer's, so that I know the link was tampered with or I have the wrong code.
90. As a user, I want the app to degrade gracefully if WebCrypto or WebRTC is unavailable in my browser, so that I get an explanatory message rather than a blank screen.
91. As a user, I want a retry button on connection-failure screens, so that I can attempt reconnection without reloading the whole app.
92. As a user, I want a clear warning if I am about to clear site data and lose my key, so that I do not accidentally render my history unrecoverable.

### UI and UX

93. As a user, I want a clean, minimal chat interface that works on both desktop and mobile browsers, so that I can use it from any device.
94. As a user, I want the interface to indicate connection state at all times (waiting / connecting / connected / disconnected), so that I am never confused about whether I can send.
95. As a user, I want the interface to indicate whether the current session is PAKE-authenticated or relying on safety-number verification, so that I know my level of protection.
96. As a user, I want the app to be usable without any configuration or setup, so that I can hand the link to a non-technical person and have it just work.
97. As a user, I want the app to load quickly, so that latency to first message is low.
98. As a user, I want a conversation list on app open, so that I can see and resume prior conversations.
99. As a user, I want to assign a display name to a peer, so that my conversation list is recognizable rather than a list of fingerprints.
100. As a user, I want the app's landing page to explain what it is and why it exists, so that I can decide whether to trust and use it.
101. As a user, I want documentation accessible from the app, so that I can understand the security model and threat surface without leaving the site.

## Implementation Decisions

### Technology stack

- **Monorepo** managed via better-t-stack (vite-plus addon). The TanStack Start app is the single app; the broker is a WebSocket route inside it and its operator-controlled STUN listener is co-deployed with it, not a third-party service.
- **App framework: TanStack Start (full-stack, `backend: self`).** One server, one process, one deploy. Chat logic runs entirely client-side — no server functions for chat. The server's only runtime role is serving the app and hosting the broker WebSocket route. Documentation and landing pages are prerendered routes inside the same app.
- **Local store: TanStack DB** with `@tanstack/browser-db-sqlite-persistence` using wa-sqlite over OPFS (IndexedDB fallback) in a dedicated Web Worker. Persistence is configured per-collection. Local-only mode (no sync backend) for v1; the architecture leaves room for a future sync backend (ElectricSQL, PowerSync, RxDB) without redesign.
- **UI components: shadcn/ui**, including the newer chat/message primitives (message bubbles, avatars, timestamps, prompt input) adapted from their AI-chat-oriented variants. The AI-specific behaviors (tool calls, streaming, reasoning blocks) are omitted; the message-layout primitives are reused.
- **Broker and STUN: operator-controlled listeners in the same deployment.** The broker is a WebSocket route inside the TanStack Start server. A standards-compliant STUN listener binds UDP port 3478 on the same operator-controlled host/network; where the runtime supports it, it may run in the same process, otherwise it is a co-deployed listener in the same Docker image. Neither component persists state, maintains presence, or emits application logs beyond what the hosting platform enforces (configured off). No third-party STUN or TURN provider is used.

### Modules

The system is organized around a small number of modules with clear boundaries. The crypto module is the deep module of the system — it encapsulates a large amount of security-critical functionality behind a small, stable interface that is fully testable in isolation with no network, no browser, and no WebRTC.

**Crypto module (deep, security-critical, fully unit-tested).**
Encapsulates all cryptographic primitives behind a narrow interface. Responsibilities:
- Generate and store a persistent device identity key pair (ECDSA P-256).
- Generate ephemeral session ECDH key pairs (P-256) per connection.
- Generate ephemeral session ECDSA signing usage (or reuse identity for signing — identity signs session keys; messages are signed by identity).
- Derive a shared AES-256 key from a local ECDH private key and a peer ECDH public key via HKDF-SHA256.
- Encrypt and decrypt messages with AES-GCM (256-bit, 96-bit nonce, authenticated).
- Sign and verify messages with ECDSA, bound to the persistent identity key.
- Compute a safety number as a truncated hash of both peers' identity public keys.
- Run SPAKE2 PAKE when a verification code is present.
- Generate and manage the at-rest encryption key (extractable AES-256 key, optional Argon2 passphrase wrapping).
- Encrypt and decrypt the export/import bundle (passphrase-wrapped identity + history).
Exposes nothing about WebRTC, signaling, or the DOM. All inputs and outputs are plain bytes/strings. This module is the one place where cryptographic correctness matters, and it is testable exhaustively against known answer vectors.

**Framing / message-protocol module.**
Defines the wire format of frames sent over the WebRTC data channel once the encrypted channel is established. Frame types include: text message, file manifest, file chunk, media manifest, media chunk, control (session key exchange, PAKE messages, safety-number announcement, identity announcement, leave). Each frame carries a type tag, a nonce, ciphertext, and a signature over the plaintext (or over the ciphertext + nonce, per a defined scheme). Large payloads are split into chunks with a manifest describing name, size, MIME type, and content hash. Reassembly and hash verification happen here. The framing module is testable against mock data channels with no real WebRTC.

**Signaling module (broker client).**
Owns the WebSocket connection to the broker. Responsibilities: connect given a broker URL and conversation ID; send and receive SDP offer/answer; send and receive ICE candidates with trickle ICE; detect peer join/leave in the room; cleanly close the socket once the data channel opens. The broker protocol is a tiny JSON message set: `join`, `offer`, `answer`, `ice`, `leave`. The same flow is used for first contact and for resumption — the client simply rejoins the room for an existing conversation ID. Testable against an in-process mock broker.

**Ephemeral-data lifecycle.**
The broker deletes a socket-to-room mapping immediately on socket close, `leave`, failed handshake, timeout, or successful transition to P2P; it retains no completed-room record. The STUN listener retains no allocation, mapping, request, or address history after replying. Each client clears SDP, ICE candidates, broker messages, PAKE material, ephemeral private keys, derived traffic keys, nonce/replay state, unsaved file buffers, and connection diagnostics when a session ends or fails. These are session-only data and must never enter the conversation store, export bundle, telemetry, or browser logs. Intentional local text history, the user's identity key, stored peer identity, and user-assigned display names remain persisted until the user clears or exports them.

**WebRTC peer module.**
Wraps `RTCPeerConnection` and `RTCDataChannel`. Responsibilities: create offer/answer; gather and apply ICE candidates; configure data channel reliability (ordered, reliable for text/control; potentially unreliable for media chunks); emit connection-state events; tear down cleanly. This module is thin and mostly forwards browser APIs, since `RTCPeerConnection` cannot be meaningfully mocked. The logic around it (state machine, retry policy) is factored out and tested separately.

**Conversation store module.**
Wraps TanStack DB collections for persisted conversations, messages, peer identity records, and local display names. Responsibilities: read/write conversations; read/write text messages (encrypted at rest before write); store peer identity keys by fingerprint for TOFU verification on resume; store user-assigned display names. Files and media are not persisted here — they are handled transiently by the framing module. The store module is testable with an in-memory TanStack DB configuration.

**Conversation orchestrator (integration layer).**
Ties the modules together into the flows: the *initiator flow* (generate conversation ID, optionally generate PAKE code, build invitation link, open signaling, create offer, wait for joiner, complete key exchange, verify peer identity on first contact or on resume, open chat) and the *participant flow* (parse link, open signaling, create answer, complete key exchange, verify peer identity, open chat). Owns the conversation lifecycle state machine: `idle → waiting → signaling → handshaking → verifying → connected → disconnected`. Coordinates resumption: on reopen, loads history from the store, rejoins the broker room, re-runs key exchange, verifies the peer's identity key matches the stored one. Holds references to the other modules and coordinates them. This module is tested with integration tests that wire real (non-mocked) crypto and framing against mocked signaling and WebRTC.

**Export/import module.**
Produces and consumes the encrypted bundle: serializes identity key + conversation history, encrypts the bundle with a passphrase-derived key (Argon2), produces a single file. Import reverses the process, with merge-or-replace logic. Testable with no network.

**UI layer (thin).**
Renders state from the orchestrator: conversation list, invitation link + QR code, waiting state, safety-number dialog, chat transcript, file/media send/receive, connection indicators, export/import affordances, landing page, docs. Built with shadcn/ui. Contains no business logic; every action delegates to the orchestrator. Kept deliberately thin so that the security-critical path lives in testable modules.

### Cryptographic design

- **Persistent identity:** ECDSA P-256 key pair, generated on first run, stored locally, never transmitted to any server. Used to sign session keys and messages, binding them to the device identity. The public key's fingerprint is the peer identifier stored locally for TOFU.
- **Ephemeral session keys:** ECDH P-256 key pair, generated fresh per connection (first contact or resumption). Public key exchanged in-band over the data channel. Shared secret fed into HKDF-SHA256 to derive the per-session AES-256-GCM key. Provides forward secrecy across sessions.
- **Message signing:** Each application-layer frame is signed by the sender's persistent identity key and verified by the receiver against the stored peer identity. Tampered or forged frames are rejected.
- **Symmetric encryption:** AES-256-GCM with a 96-bit nonce per message. Nonces are generated by the crypto module and must not repeat under the same key; uniqueness is enforced.
- **Safety number:** `Base10(Truncate(SHA-256(conversationId || sort(A_idpub, B_idpub)), 40 bits))`, displayed as grouped digits. Computed over the persistent identity public keys and conversation ID (not session keys), so it is stable across resumptions of the same conversation while remaining distinct for another conversation between the same identities.
- **PAKE (optional):** SPAKE2 when a verification code is present. The code is a 6-digit decimal number carried in the URL fragment. Run over the data channel after it opens; success authenticates the key exchange against an active MITM on the broker channel without ever transmitting the code. Failure aborts loudly — no silent fallback.
- **At-rest encryption:** A random AES-256 key generated via WebCrypto (extractable, stored locally as raw key material). All persisted text messages are encrypted with this key before being written to the SQLite WASM store. Optional passphrase mode wraps this key via Argon2 (key derivation); in passphrase mode, the wrapped key is stored and the raw key is held only in memory while the app is unlocked. The extractable key property is what enables the export/import bundle.
- **Export/import bundle:** Serializes identity key + conversation history, encrypts with a key derived from a user-chosen passphrase via Argon2. Single file, portable across devices.

### Security closure decisions

The following decisions close ambiguities found while pressure-testing the design. They do not change the stated product scope; they make the existing security claims precise.

- **Handshake transcript and key schedule:** The application handshake is a versioned, canonical binary transcript. It includes the protocol version, conversation ID, both identity public keys, both ephemeral ECDH public keys, each peer's random session ID, each peer's authentication mode, and deterministic initiator/responder roles. Identity signatures cover this complete transcript, not an individual public key. The final traffic key is derived with HKDF-SHA256 from the ECDH secret and the transcript hash, with distinct labeled outputs for each direction. This prevents unknown-key-share, cross-conversation, reflection, role-confusion, and key/nonce reuse across resumptions.
- **PAKE is mandatory when requested:** A link with a code sets the expected authentication mode before signaling begins. Both clients must confirm that mode in the signed transcript. A PAKE session key is mixed into the final traffic-key derivation and the PAKE confirmation messages are bound to the same transcript hash. Any missing, mismatched, failed, or unsupported PAKE state is terminal for that attempt; it never falls back to ECDH-only mode. The chosen SPAKE2 variant, curve/group, encodings, transcript binding, and test vectors must be specified before implementation and supplied by a maintained, independently reviewed implementation rather than improvised WebCrypto glue.
- **Six-digit-code limit:** A six-digit code has about 20 bits of entropy. It is not a high-entropy secret and must not be described as unconditionally brute-force resistant. Each endpoint permits one PAKE attempt for a given link/session and durably marks the invitation authentication as failed before accepting another connection. Recovering from a failed PAKE requires creating and sharing a fresh invitation. This limits online guessing to a denial-of-service-prone single guess per invitation; availability remains unprotected against a malicious broker. A future higher-entropy fragment secret can improve this without changing the human-readable code.
- **Safety-number semantics:** A safety number is only evidence of authentication after the people compare it through an independent trusted channel. The application cannot detect a mismatch by itself because it has no expected remote value. The displayed number is derived from the canonical identity-key pair and conversation ID, and is explicitly labeled “unverified” until the user marks it compared. It is a stable per-conversation value, not a universal identifier for the same two identities.
- **TOFU and identity changes:** On first contact, the peer identity is stored only after a complete authenticated handshake. On resumption, an unexpected identity is a blocking identity-change warning, not a silently replaceable record. The user must explicitly choose to distrust the stored conversation and establish a new one; accepting a changed key in place would defeat TOFU. First contact without PAKE remains vulnerable to MITM unless users compare the safety number.
- **Frame integrity and replay:** Every encrypted frame carries the protocol version, session ID, monotonically increasing sender sequence number, frame type, and chunk/transfer identifiers as authenticated additional data. The receiver keeps a bounded replay window per sender/session and rejects duplicate, stale, malformed, and out-of-window frames before allocating payload buffers. AES-GCM nonces are deterministically unique per direction from the session ID plus sequence number; the sender must stop before the sequence space is exhausted. Signatures, if retained in addition to AEAD authentication, cover this same canonical frame representation. A signature alone does not prevent replay.
- **Resource and file-transfer limits:** The protocol defines finite limits for text-frame size, file size, chunk size, concurrent transfers, incomplete-transfer bytes, buffered data, and handshake/frame parsing time. Manifests are authenticated before allocation; chunks are accepted only for an active manifest; cancellation and disconnect release all transient buffers. Backpressure reserves capacity for control and text frames so a peer cannot turn a file transfer into unbounded memory use or permanent chat starvation.
- **Invitation and room behavior:** Conversation IDs are CSPRNG-generated, at least 128 bits of entropy, validated strictly, and are opaque bearer rendezvous handles. Anyone who obtains one can attempt to occupy its two broker slots or disrupt availability; PAKE authenticates content but cannot prevent this denial of service. A simultaneous rejoin uses the transcript's deterministic roles and a perfect-negotiation collision policy so two offerers cannot deadlock. Broker-originated role messages are never trusted for cryptographic identity or authentication.
- **Identity-key storage and export:** An identity private key must be exportable to support the stated export/import feature. Therefore “never leaves the device” means never sent to the broker or another network service; an explicit user export intentionally contains it, encrypted by the export passphrase. The identity key and the auto at-rest key are protected by browser origin storage, not by encryption against an attacker who can read that same unlocked browser profile.
- **At-rest guarantee:** Auto-key mode protects copied database material that lacks the corresponding browser key store, but does not protect against a user, malware, extension, or attacker with access to the active browser profile/origin. Passphrase mode is required for protection against offline browser-profile copies, provided the app is locked and the passphrase has not been entered. This limitation must be stated in the UI and threat model.
- **Metadata and direct-connect exposure:** The broker can associate the stable conversation ID with every signaling attempt it observes while it is running, even if it retains no logs. WebRTC peers normally learn each other's network candidates and IP addresses. The deployment's own STUN listener necessarily receives a client's source IP in order to return its NAT mapping, but receives no room ID or application content and immediately discards that request state. Fragment URLs are absent from HTTP requests but remain bearer secrets that can leak through sharing, clipboard history, screenshots, browser extensions, or malicious client-side code. No telemetry reduces app-created disclosure; it cannot prevent platform, network, or endpoint metadata.
- **Build and endpoint trust:** Cryptography in a browser cannot protect users served a malicious build, nor an endpoint controlled by malware or a privileged extension. Source inspection alone does not prove the deployed bytes match source. Self-hosting or independently verified/reproducible release artifacts are required for users whose threat model includes a malicious operator; this remains outside v1 implementation scope.

### Signaling / broker design

- **Transport:** WebSocket. JSON messages.
- **Protocol messages:** `join { roomId }`, `offer { sdp }`, `answer { sdp }`, `ice { candidate }`, `leave { roomId }`. The broker does not parse SDP or ICE; it forwards opaque blobs between the two peers currently in a room.
- **Room model:** A room is identified by a conversation ID. At most two peers per room. The second peer to join triggers offer/answer exchange. When both peers have disconnected from the broker (after data channel open), the room ceases to exist in broker memory. No persistence of any kind. The same room/conversation ID can be rejoined later by either party for resumption — the broker treats it identically to a first contact.
- **No presence:** The broker holds an in-memory mapping of currently-connected sockets to rooms. It does not track "who is online" in any persistent or queryable sense. There is no presence table, no last-seen, no online/offline state. "Both parties are online" is an emergent property of both currently being connected to the broker in the same room, which is the prerequisite for signaling to proceed. When a peer disconnects, the mapping is dropped immediately.
- **Statelessness:** The broker holds room→socket mappings in process memory only. A restart wipes everything. There is no database, no log file, no access log beyond what the hosting platform enforces (which should be configured off).
- **Broker scope:** Signaling only. The broker never relays application messages, file chunks, or media. Once the data channel is open, the broker is out of the data path entirely.
- **Colocation:** The broker is a WebSocket route on the same TanStack Start server as the app. Same process, same deploy. It is not a separate service; the client connects to it on the same origin.

### WebRTC configuration

- **ICE servers:** STUN only, using the operator-controlled STUN listener deployed with the broker, for example `stun:app.example:3478`. No third-party ICE service and no TURN relay are used in v1. STUN returns a client's public NAT mapping so direct WebRTC connectivity can be attempted; it is not in the chat data path and does not receive a room ID or message content. The connection-failure case for symmetric-NAT peers is documented and surfaced as a clear error to the user.
- **Data channel:** A single ordered, reliable data channel for v1. Text, control, file manifests, file chunks, and media chunks all multiplex on it with backpressure handling. A second unreliable channel for media chunks is a possible future optimization but not in v1.
- **Trickle ICE:** Enabled. Candidates are sent as they are gathered to minimize time-to-connect.
- **Disconnect from broker:** Triggered on `datachannel.onopen`. The signaling socket is closed immediately. A short grace period (e.g. 2 seconds) keeps the socket open in case the channel drops instantly and re-signaling is needed, then closes.

### Link structure

- **URL form:** `https://app.example/#<conversationId>` or `https://app.example/#<conversationId>~<code>` when a PAKE code is used.
- **Fragment only:** Everything sensitive lives in the URL fragment, which browsers never transmit to any server. The conversation ID is in the fragment so the app server's HTTP logs never see it; only the broker sees it, and only when the client opens the signaling WebSocket.
- **Stable link:** The conversation ID never changes. The same link works for first contact and for every resumption.
- **Code format:** 6 decimal digits when present, generated by the initiator's CSPRNG.

### Deployment

- **One deploy.** The TanStack Start server serves the app and hosts the broker WebSocket route; the same operator-controlled Docker deployment exposes the STUN UDP listener. It may be one process when the runtime supports both HTTP/WebSocket and UDP binding, or co-deployed processes in one image when it does not. Web deploy target: Docker. UDP port 3478 and the HTTPS/WebSocket port must be publicly reachable.
- **No telemetry:** No analytics, no error reporting that exfiltrates data. Errors are surfaced in the UI only.

## Testing Decisions

### What makes a good test here

A good test exercises external behavior through a module's public interface, not its internals. It does not reach into private state. It does not depend on real WebRTC, real network, or a real browser unless the test is explicitly an end-to-end smoke test. Crypto tests in particular must use known-answer vectors (KATs) from standards, not self-consistency checks, because a self-consistent but wrong implementation passes its own tests. Persistence tests should verify round-trip behavior (write, reload, read) through the public store interface, not by inspecting SQLite files directly.

### Modules to be tested

**Crypto module — exhaustive unit tests, highest priority.**
This is the deep module and the security-critical one. Tests must cover:
- Persistent identity key pair generation produces valid P-256 points.
- Ephemeral ECDH key pair generation produces valid P-256 points.
- Two independent ECDH key pairs derive the same shared secret regardless of which side initiates.
- HKDF expansion produces the expected 256-bit key for a known input.
- AES-GCM round-trips for arbitrary plaintext; tampered ciphertext fails to decrypt; nonce reuse is rejected.
- ECDSA signing produces verifiable signatures; tampered messages fail verification; signatures from the wrong key fail.
- Safety number is symmetric (both peers compute the same value from identity keys) and changes when either identity key changes.
- Safety number is stable across resumptions (same identity keys → same safety number).
- SPAKE2 succeeds when both peers use the same code and fails (aborts) when codes differ.
- Identity signatures reject a transcript with a changed conversation ID, role, authentication mode, session ID, identity key, or ephemeral key; directional key derivation produces distinct keys.
- PAKE output bound to a transcript derives matching traffic keys only for matching code, mode, and transcript; missing or failed PAKE cannot fall back to ECDH-only traffic keys.
- A failed PAKE attempt persistently blocks reuse of that invitation; a fresh invitation allows a new attempt.
- At-rest key generation produces a usable AES-256 key; message round-trip through at-rest encrypt/decrypt works.
- Argon2 passphrase wrapping round-trips; wrong passphrase fails to unwrap.
- Export/import bundle round-trips; wrong passphrase fails to decrypt; bundle contents (identity + history) are intact after round-trip.
- Known-answer tests against published test vectors for AES-GCM, HKDF, ECDSA, and SPAKE2 where available.

**Framing module — unit tests with mock channels.**
Tests must cover: round-trip of a text frame; chunking of a large file into manifest + chunks; reassembly and hash verification of a complete file; rejection of a chunk whose hash does not match; rejection of a frame with a bad signature; rejection of replayed, stale, out-of-window, or wrong-session sequence numbers; authenticated-data rejection when the type or transfer ID changes; bounded-allocation behavior for malformed manifests; backpressure behavior when the mock channel reports buffered.

**Signaling module — unit tests against an in-process mock broker.**
Tests must cover: join creates a room; a second join triggers offer/answer relay; ICE candidates are forwarded in both directions; leave cleans up; the client closes its socket after a simulated `onopen`; resumption (re-join of an existing room ID) works identically to first contact; simultaneous rejoin resolves offer collision deterministically; malformed or oversized room IDs and third-peer joins are rejected without displacing either peer.

**Conversation store module — unit tests with in-memory TanStack DB.**
Tests must cover: write and read a conversation; write and read text messages with at-rest encryption (ciphertext is what is stored, plaintext is what is returned); store and look up a peer identity by fingerprint; update a display name; clear a conversation's history; clear all history; export-then-import round-trip restores all data.

**Conversation orchestrator — integration tests with mocked signaling and WebRTC, real crypto and framing.**
Tests must cover: the initiator flow produces a valid invitation link; the participant flow parses it and connects; the key exchange completes and both sides derive the same session AES key; the safety number matches; a PAKE mismatch aborts; a dropped connection transitions the state machine to `disconnected` and allows re-signaling; resumption verifies the peer's identity key against the stored one and flags a mismatch; resumption uses fresh session keys.

**Export/import module — unit tests.**
Tests must cover: bundle round-trip; wrong passphrase rejection; merge-vs-replace behavior on import; bundle integrity (identity + history both present and correct).

**UI layer — not unit-tested in v1.**
The UI is kept thin enough that manual verification suffices. End-to-end smoke tests (two real browsers, two real tabs) are run manually before release.

### Prior art

This is a greenfield repository, so there is no prior art in-tree. The testing approach follows standard practice for security-critical JavaScript: KATs for primitives, mock-channel integration for protocol modules, and manual end-to-end for the full browser path. The pattern is the same one used by libsodium.js, the Web Crypto test suites, and the Signal libsignal test suite.

## Out of Scope

- **Group chat.** v1 is strictly 1:1. Multiparty (full mesh or SFU) is a separate future PRD with its own key-agreement design (sender keys or pairwise).
- **TURN relay.** v1 ships STUN-only. Symmetric-NAT peer pairs will fail to connect; this is documented and accepted. TURN can be added later without breaking the design.
- **Server-side message storage.** Explicitly excluded by design. The broker is a pure signaling relay with no persistence. An encrypted mailbox for async delivery is a possible future addition but is out of scope for v1.
- **Presence system.** Explicitly excluded. There is no online/offline tracking, no last-seen, no presence table. Resumption works by both parties rejoining the broker room; "online" is emergent, not tracked.
- **In-conversation forward secrecy (ratcheting).** v1 uses one ephemeral session key per connection. Forward secrecy holds across sessions (each reconnection uses fresh keys) but not within a single session. Per-message ratcheting (a la Signal's Double Ratchet) is out of scope; the per-session ephemeral key provides forward secrecy across sessions. Ratcheting is a candidate for a future hardening PRD.
- **Sync backend.** v1 is local-only. The architecture leaves room for a future sync backend (ElectricSQL, PowerSync, RxDB) for multi-device sync, but no sync is implemented in v1. Multi-device in v1 is via manual export/import only.
- **Mobile native apps.** v1 is a web app. A PWA "install" affordance may be added, but native iOS/Android wrappers are out of scope.
- **Server-side scanning compliance.** This is structurally impossible by design and is not a goal. The name reflects this.
- **Broker authentication / rate limiting.** v1 ships an open broker. Abuse resistance (per-IP rate limits, room TTLs) is an operational concern deferred to deployment, not a v1 feature.
- **File and media persistence.** Files and media are ephemeral in v1 — received in the moment, must be saved explicitly or are lost when the conversation view closes. Only text is persisted. Persisting media is a candidate for a future PRD with size caps and eviction policy.

## Further Notes

### On the name

The working name "Fuck EU Chat Control" is deliberately provocative. The EU's proposed "Chat Control" regulation would require messaging providers to scan message content, including end-to-end-encrypted content, for CSAM. A system whose broker never sees content and drops out of the data path after handshake is structurally incapable of complying with such a mandate without being redesigned from scratch. The name makes the political intent explicit: this is a tool whose entire architecture exists to make server-side scanning inapplicable. If a less confrontational name is wanted for broader adoption, the architecture is name-agnostic.

### On the threat model, stated plainly

The system protects the *content* of conversations against:
- The broker (sees only signaling metadata and encrypted key-exchange bytes over DTLS; holds no persistent state; holds no presence table).
- Network observers between peers (see DTLS-SRTP encrypted traffic).
- A passive observer who has not obtained the invitation link or its fragment. The invitation is a bearer rendezvous handle; PAKE additionally authenticates a holder of the code, subject to the six-digit-code limitation above.
- A future compromise of the broker's logs (there are no logs).
- A copied local message database that does not include the corresponding browser-origin key material. Auto-key mode does not protect an unlocked browser profile; passphrase mode can protect an offline profile copy while the app is locked.
- Compromise of one session's keys (other sessions use fresh ephemeral keys; forward secrecy across sessions holds).

The system does *not* protect against:
- A global passive adversary performing traffic analysis on timing and size of P2P packets. Padding and traffic shaping are future work.
- An active MITM on the broker when no PAKE code is used *and* the users do not compare safety numbers. This is the fundamental limitation of unauthenticated key exchange; PAKE or safety-number verification is the mitigation.
- The user's own device being compromised (malware, browser extension in the same origin, etc.). No in-browser crypto can defend against a hostile endpoint. Passphrase mode raises the bar but does not eliminate this.
- A peer learning the other peer's IP address through direct WebRTC candidates. The deployment's own STUN listener necessarily receives a client's source IP to answer its request, but stores neither that request nor conversation metadata. Avoiding peer IP disclosure requires a relay or anonymity layer, neither of which is in v1.
- Availability attacks: a malicious broker or anyone holding a conversation ID can delay, drop, occupy, or terminate signaling; PAKE and safety-number verification authenticate a peer but do not make the connection available.
- The operator of the server being compelled to serve a backdoored build or to compromise the broker route. Subresource integrity, reproducible builds, and self-hosting are the mitigations; out of scope for v1 but worth documenting for users.
- Loss of the at-rest key (e.g. via clearing browser site data). Persisted ciphertext becomes unrecoverable. This is surfaced clearly in the UI; export/import is the backup mechanism.

### On the broker's irreducible metadata

Even a pure-relay, no-log, no-presence broker sees, during the handshake window only: both peers' IP addresses, the stable conversation ID, and the timing of the SDP/ICE exchange. A stable ID is linkable across resumptions by any broker instance or infrastructure log that observes them; “no persistence” means the application deliberately retains none, not that observation is impossible. After both peers disconnect, the broker process holds nothing. The same deployment's STUN listener sees a source IP only long enough to answer its mapping request; it has no room ID or application protocol input and retains no request record. The peers also normally learn one another's candidate/IP information. The only way to reduce peer-to-peer IP disclosure is to add relays and/or onion routing, which are out of scope for v1 but compatible with the design.

### On resumption and identity

Resumable conversations introduce a persistent identity key per device. This is a deliberate trade-off: it enables conversation continuity and TOFU verification, at the cost of a stable identifier stored on the user's device. The identity key never reaches the broker. A peer's stored fingerprint is local-only metadata. If a user wishes to "reset" their identity, they can generate a new one (losing the ability to be recognized by prior peers) — this is a future affordance, not a v1 feature, but the architecture permits it.

### On future hardening (not in this PRD)

Candidate follow-up PRDs, listed so they are not forgotten:
- Per-message ratcheting for within-conversation forward secrecy.
- TURN relay (ciphertext-only) for NAT-fallback reliability.
- Encrypted mailbox for async delivery.
- Sync backend (ElectricSQL / PowerSync / RxDB) for multi-device sync beyond export/import.
- Traffic-shaping / padding against timing analysis.
- Reproducible builds and SRI for client integrity.
- Group chat (sender-keys or pairwise mesh).
- Identity reset / rotation affordance.
- Media persistence with size caps and eviction policy.
