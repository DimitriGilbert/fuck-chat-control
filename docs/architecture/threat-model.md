# Threat Model

This document states what the system protects, what it does not protect
against, and the design decisions that make the security claims precise. It
is the security reference for reviews and for the user-facing documentation.

The codebase implements two authentication modes. Both are first-class:

- **Safety-number-only** (`AuthMode.SafetyNumberOnly`, `0x01`) — the default.
  The channel is authenticated only if the two users compare a per-chat
  safety number out of band.
- **PAKE** (`AuthMode.Pake`, `0x02`) — optional, enabled by protecting a chat
  with a 6-digit code. A SPAKE2 exchange is folded into the key schedule, so
  a man-in-the-middle who does not know the code cannot complete the
  handshake. Available on web and desktop; the mobile (React Native) build
  is safety-number-only because the SPAKE2 wasm is not bundled there.

See [ADR 001](../adr/001-crypto-dependencies.md) and the
[protocol spec](protocol-v1.md).

## What the system protects (the content of conversations)

The system protects the content of conversations against:

- **The broker.** The broker sees only signaling metadata and encrypted
  key-exchange bytes travelling over DTLS. It holds no persistent state, no
  presence table, and no message log. Once the WebRTC data channel opens,
  both peers disconnect from the broker and it leaves the data path.
- **Network observers between peers.** They see DTLS-encrypted traffic on
  the data channel and TLS/WSS-encrypted signaling.
- **A passive observer who has not obtained the invitation link.** The
  invitation is a bearer rendezvous handle; possession of the conversation
  ID (carried only in the URL fragment, never sent to the app server in an
  HTTP request) is required to reach the broker room for that conversation.
- **A future compromise of the broker's logs.** There are no application
  logs. Infrastructure logs are minimized operationally and turned off where
  the platform allows.
- **A copied local message database that does not include the corresponding
  browser-origin key material.** Auto-key at-rest encryption protects the
  ciphertext in this case.
- **Compromise of one session's keys.** Each connection (first contact or
  resumption) uses fresh ephemeral ECDH P-256 keys expanded via HKDF-SHA256.
  Forward secrecy holds across sessions.
- **An active man-in-the-middle on the broker, when the chat uses PAKE and
  the code was shared over an independent channel.** The SPAKE2 exchange is
  folded into the key schedule and verified by a confirmation tag, so an
  attacker who does not know the code cannot complete the handshake or
  derive matching traffic keys. This is the property safety-number-only
  mode lacks unless the number is compared.

## What the system does not protect against

- **A global passive adversary performing traffic analysis** on the timing
  and size of P2P packets. Padding and traffic shaping are future work.
- **An active man-in-the-middle on the broker when a safety-number chat is
  used without comparing the safety number.** This is the fundamental
  limitation of unauthenticated key exchange. Safety-number-only mode's sole
  MITM mitigation is out-of-band comparison: both users must compare the
  per-chat safety number over an independent trusted channel. Without that
  comparison, a malicious broker can substitute keys during signaling and
  neither user nor the application can detect it. PAKE mode closes this gap
  for chats that opt in, provided the 6-digit code reaches the peer through
  a channel the MITM does not control.
- **The user's own device being compromised** (malware, a same-origin
  browser extension, a keylogger, or any privileged endpoint attacker). No
  in-browser cryptography defends against a hostile endpoint. Passphrase
  mode raises the bar against an offline profile copy but does not eliminate
  an online endpoint compromise.
- **Peer-to-peer IP disclosure.** WebRTC peers normally learn each other's
  network candidates and therefore IP addresses. The deployment's STUN
  listener necessarily receives a client's source IP to return its NAT
  mapping, then discards that request state. It never receives a room ID or
  application content. Hiding peer IPs requires a relay or an anonymity
  layer; TURN relay (when configured) is in the path only for relayed
  connections.
- **Availability attacks.** A malicious broker, or anyone holding a
  conversation ID, can delay, drop, occupy the two broker slots, or
  terminate signaling. Safety-number verification or PAKE authenticates a
  peer but does not make the connection available. The broker is open;
  abuse resistance is an operational concern deferred to deployment.
- **The operator of the server being compelled to serve a backdoored build**
  or to compromise the broker route. Subresource integrity, reproducible
  builds, and self-hosting are the mitigations. They are out of scope for
  implementation but are documented for users whose threat model includes a
  malicious operator.
- **Loss of the at-rest key** (for example by clearing browser site data).
  Persisted ciphertext becomes unrecoverable. This is surfaced in the UI;
  export/import is the backup mechanism.
- **PAKE with a code transmitted only through the invitation link.** The
  6-digit code lives in the URL fragment (`#<hex>~NNNNNN`). Anyone who
  intercepts the link intercepts the code, defeating PAKE. For the full
  MITM protection the code should be conveyed through a separate side
  channel; the link is a convenience, not a trusted channel.

## Security closure decisions

These decisions close ambiguities found while pressure-testing the design.
They make the existing security claims precise.

### Handshake transcript and key schedule

The application handshake is a versioned, canonical binary transcript. It
includes the protocol version, conversation ID, both identity public keys,
both ephemeral ECDH public keys, each peer's random session ID, the
authentication mode, and deterministic initiator/responder roles. Identity
signatures cover this complete transcript, not an individual public key. The
final traffic key is derived with HKDF-SHA256 from the ECDH secret and the
transcript hash, with distinct labeled outputs for each direction. For PAKE
sessions, the SPAKE2 shared secret is appended to the traffic-key HKDF info,
so a wrong code yields non-matching keys. This construction prevents
unknown-key-share, cross-conversation, reflection, role-confusion, and
key/nonce reuse across resumptions.

The canonical transcript encoding is frozen in [protocol-v1.md](protocol-v1.md).

### Authentication mode

`AuthMode` has two values: `SafetyNumberOnly` (`0x01`) and `Pake` (`0x02`).
The handshake transcript records the mode and both peers must agree on it;
an unknown or mismatched mode on the wire is a terminal protocol error.

**Safety-number mode** displays a per-chat safety number — the first 40 bits
of `SHA-256(conversationId || sort(init_idpub, resp_idpub))`, rendered as
twelve decimal digits — to both users. It is evidence of authentication only
after the people compare it through an independent trusted channel. The
application cannot detect a mismatch by itself because it has no expected
remote value; the displayed number is labelled "unverified" until the user
marks it compared. It is a stable per-chat value (stable across resumptions
of the same chat between the same identity keys), not a universal identifier
for the same two identities.

**PAKE mode** runs a SPAKE2 (RFC 9383) exchange over Ed25519, using the raw
6-digit code as the password. The two peers exchange shares, then each
verifies the other with a confirmation tag keyed by the SPAKE2 shared secret
over the transcript hash. A wrong code produces divergent secrets, the
confirm tags do not match, and the handshake aborts with a durable
auth-failure flag; retry on the same chat is blocked until a fresh
invitation is created. A man-in-the-middle who does not know the code cannot
produce a matching tag. Because PAKE authenticates the handshake directly,
the out-of-band safety-number comparison is not required for these chats —
though the safety number is still computed and shown, on the same formula as
for safety-number chats.

### TOFU and identity changes

On first contact, the peer identity is stored only after a complete
authenticated handshake. On resumption, an unexpected identity is a blocking
identity-change warning, not a silently replaceable record. The user must
explicitly choose to distrust the stored conversation and establish a new
one; accepting a changed key in place would defeat TOFU. First contact under
safety-number mode without a compared safety number remains vulnerable to
MITM.

### Frame integrity and replay

Every encrypted frame carries the protocol version, session ID, monotonically
increasing sender sequence number, frame type, and chunk/transfer identifiers
as authenticated additional data (AAD). The receiver keeps a bounded replay
window per sender/session and rejects duplicate, stale, malformed, and
out-of-window frames before allocating payload buffers. AES-GCM nonces are
constructed from the sender's session ID and the sequence number; the sender
must stop before the sequence space is exhausted. The ECDSA identity
signature covers the canonical transcript, not each frame. A signature alone
does not prevent replay — the AAD-bound sequence number and replay window do.

### Resource and file-transfer limits

The protocol defines finite limits for text-frame size, file size, chunk
size, concurrent transfers, incomplete-transfer bytes, buffered data, and
handshake/frame parsing time. Manifests are authenticated before allocation;
chunks are accepted only for an active manifest; cancellation and disconnect
release all transient buffers. Backpressure reserves capacity for control and
text frames so a peer cannot turn a file transfer into unbounded memory use
or permanent chat starvation. The frozen values are in
[protocol-v1.md](protocol-v1.md).

### Invitation and room behavior

Conversation IDs are CSPRNG-generated, exactly 128 bits, validated strictly,
and are opaque bearer rendezvous handles. Anyone who obtains one can attempt
to occupy its two broker slots or disrupt availability; safety-number
verification or PAKE authenticates content but cannot prevent this denial of
service. A simultaneous rejoin uses the transcript's deterministic roles and
a perfect-negotiation collision policy so two offerers cannot deadlock.
Broker-originated role messages are never trusted for cryptographic identity
or authentication.

For PAKE chats the invitation also carries the 6-digit code in the fragment
(`#<hex>~NNNNNN`). The fragment never reaches the server, but it is a bearer
secret: anyone who sees the link sees the code.

### Identity-key storage and export

An identity private key must be exportable to support the stated
export/import feature. "Never leaves the device" therefore means never sent
to the broker or another network service; an explicit user export
intentionally contains it, encrypted by the export passphrase. The identity
key and the auto at-rest key are protected by browser origin storage, not by
encryption against an attacker who can read that same unlocked browser
profile.

### At-rest guarantee

Auto-key mode protects copied database material that lacks the corresponding
browser key store, but does not protect against a user, malware, extension,
or attacker with access to the active browser profile or origin. Passphrase
mode (Argon2id wrapping) is required for protection against offline
browser-profile copies, provided the app is locked and the passphrase has not
been entered. This limitation is stated in the UI and here.

### Metadata and direct-connect exposure

The broker can associate the stable conversation ID with every signaling
attempt it observes while it is running, even if it retains no logs. WebRTC
peers normally learn each other's network candidates and IP addresses. The
deployment's STUN listener necessarily receives a client's source IP to
return its NAT mapping, but receives no room ID or application content and
immediately discards that request state. Fragment URLs are absent from HTTP
requests but remain bearer secrets that can leak through sharing, clipboard
history, screenshots, browser extensions, or malicious client-side code. No
telemetry reduces app-created disclosure; it cannot prevent platform,
network, or endpoint metadata.

### Build and endpoint trust

Cryptography in a browser cannot protect users served a malicious build, nor
an endpoint controlled by malware or a privileged extension. Source
inspection alone does not prove the deployed bytes match source. Self-hosting
or independently verified/reproducible release artifacts are required for
users whose threat model includes a malicious operator; this remains outside
implementation scope.
