# Threat Model

This document states plainly what the v1 system protects, what it does
not protect against, and the closure decisions that make the security
claims precise. It is the standalone security reference for
contributions, reviews, and the user-facing security documentation.

v1 authentication is **safety-number-only**. There is no PAKE and no
six-digit verification code in v1. See
[ADR 001](../adr/001-crypto-dependencies.md).

## What the system protects (content of conversations)

The system protects the _content_ of conversations against:

- **The broker.** The broker sees only signaling metadata and encrypted
  key-exchange bytes travelling over DTLS-SRTP. It holds no persistent
  state, no presence table, and no message log. Once the WebRTC data
  channel opens, both peers disconnect from the broker and it leaves
  the data path entirely.
- **Network observers between peers.** They see DTLS-SRTP encrypted
  traffic on the data channel and TLS/WSS encrypted signaling.
- **A passive observer who has not obtained the invitation link.** The
  invitation is a bearer rendezvous handle; possession of the
  conversation ID (transmitted only in the URL fragment, never sent to
  the app server in an HTTP request) is required to reach the broker
  room for that conversation.
- **A future compromise of the broker's logs.** There are no
  application logs. Infrastructure logs are minimized operationally and
  configured off where the platform allows.
- **A copied local message database that does not include the
  corresponding browser-origin key material.** Auto-key at-rest
  encryption protects the ciphertext in this case.
- **Compromise of one session's keys.** Each connection (first contact
  or resumption) uses fresh ephemeral ECDH P-256 keys expanded via
  HKDF-SHA256. Forward secrecy holds across sessions.

## What the system does NOT protect against

- **A global passive adversary performing traffic analysis** on the
  timing and size of P2P packets. Padding and traffic shaping are
  future work.
- **An active man-in-the-middle on the broker when the users do not
  compare the safety number.** This is the fundamental limitation of
  unauthenticated key exchange. v1's sole MITM mitigation is
  safety-number comparison: both users must compare the per-conversation
  safety number over an independent trusted channel. Without that
  comparison, a malicious broker can substitute keys during signaling
  and neither user, nor the application, can detect it.
- **The user's own device being compromised** (malware, a same-origin
  browser extension, a keylogger, or any privileged endpoint
  attacker). No in-browser cryptography defends against a hostile
  endpoint. Passphrase mode raises the bar against an _offline_ profile
  copy but does not eliminate an _online_ endpoint compromise.
- **Peer-to-peer IP disclosure.** WebRTC peers normally learn each
  other's network candidates (and therefore IP addresses). The
  deployment's own STUN listener necessarily receives a client's source
  IP to return its NAT mapping, then discards that request state. It
  never receives a room ID or application content. Avoiding peer IP
  disclosure requires a relay or anonymity layer, neither of which is
  in v1.
- **Availability attacks.** A malicious broker, or anyone holding a
  conversation ID, can delay, drop, occupy the two broker slots, or
  terminate signaling. Safety-number verification authenticates a peer
  but does not make the connection available. The broker is open in v1;
  abuse resistance is an operational concern deferred to deployment.
- **The operator of the server being compelled to serve a backdoored
  build** or to compromise the broker route. Subresource integrity,
  reproducible builds, and self-hosting are the mitigations. They are
  out of scope for v1 but are documented for users whose threat model
  includes a malicious operator.
- **Loss of the at-rest key** (e.g. by clearing browser site data).
  Persisted ciphertext becomes unrecoverable. This is surfaced clearly
  in the UI; export/import is the backup mechanism.

## Security closure decisions

The following decisions close ambiguities found while pressure-testing
the design. They make the existing security claims precise.

### Handshake transcript and key schedule

The application handshake is a versioned, canonical binary transcript.
It includes the protocol version, conversation ID, both identity public
keys, both ephemeral ECDH public keys, each peer's random session ID,
the authentication mode, and deterministic initiator/responder roles.
Identity signatures cover this complete transcript, not an individual
public key. The final traffic key is derived with HKDF-SHA256 from the
ECDH secret and the transcript hash, with distinct labeled outputs for
each direction. This prevents unknown-key-share, cross-conversation,
reflection, role-confusion, and key/nonce reuse across resumptions.

The canonical transcript encoding is frozen in
[protocol-v1.md](protocol-v1.md).

### Authentication mode: safety-number-only (PAKE removed for v1)

v1 has exactly one authentication mode: `SafetyNumberOnly`. The
handshake transcript records this mode and both peers must agree on it.
An unknown or mismatched mode on the wire is a terminal protocol error.

A per-conversation safety number —
`Base10(Truncate(SHA-256(conversationId || sort(init_idpub, resp_idpub)), 40 bits))`
displayed as grouped digits — is shown to both users. It is **evidence
of authentication only after the people compare it through an
independent trusted channel**. The application cannot detect a mismatch
by itself because it has no expected remote value; the displayed number
is explicitly labelled "unverified" until the user marks it compared. It
is a stable per-conversation value (stable across resumptions of the
same conversation between the same identity keys), not a universal
identifier for the same two identities.

Without safety-number comparison, the channel is vulnerable to an active
MITM on the broker. This is the sole residual MITM risk in v1 and it is
stated plainly in the UI. A future PAKE-bearing mode (SPAKE2 or OPAQUE)
may be added behind a narrow adapter and mixed into the key schedule
exactly as the original closure decision specified; that work is
deferred to a hardening PRD and must not be assumed by any v1 module.

### TOFU and identity changes

On first contact, the peer identity is stored only after a complete
authenticated handshake. On resumption, an unexpected identity is a
**blocking identity-change warning**, not a silently replaceable record.
The user must explicitly choose to distrust the stored conversation and
establish a new one; accepting a changed key in place would defeat
TOFU. First contact without a compared safety number remains vulnerable
to MITM.

### Frame integrity and replay

Every encrypted frame carries the protocol version, session ID,
monotonically increasing sender sequence number, frame type, and
chunk/transfer identifiers as authenticated additional data (AAD). The
receiver keeps a bounded replay window per sender/session and rejects
duplicate, stale, malformed, and out-of-window frames **before**
allocating payload buffers. AES-GCM nonces are deterministically unique
per direction from the sender's session ID plus the sequence number
(see [protocol-v1.md](protocol-v1.md)); the sender must stop before the
sequence space is exhausted. The ECDSA identity signature covers this
same canonical frame representation. A signature alone does not prevent
replay — the AAD-bound sequence number and replay window do.

### Resource and file-transfer limits

The protocol defines finite limits for text-frame size, file size,
chunk size, concurrent transfers, incomplete-transfer bytes, buffered
data, and handshake/frame parsing time. Manifests are authenticated
before allocation; chunks are accepted only for an active manifest;
cancellation and disconnect release all transient buffers. Backpressure
reserves capacity for control and text frames so a peer cannot turn a
file transfer into unbounded memory use or permanent chat starvation.
The frozen values are in [protocol-v1.md](protocol-v1.md).

### Invitation and room behavior

Conversation IDs are CSPRNG-generated, exactly 128 bits, validated
strictly, and are opaque bearer rendezvous handles. Anyone who obtains
one can attempt to occupy its two broker slots or disrupt availability;
safety-number verification authenticates content but cannot prevent
this denial of service. A simultaneous rejoin uses the transcript's
deterministic roles and a perfect-negotiation collision policy so two
offerers cannot deadlock. Broker-originated role messages are never
trusted for cryptographic identity or authentication.

### Identity-key storage and export

An identity private key must be exportable to support the stated
export/import feature. Therefore "never leaves the device" means never
sent to the broker or another network service; an explicit user export
intentionally contains it, encrypted by the export passphrase. The
identity key and the auto at-rest key are protected by browser origin
storage, not by encryption against an attacker who can read that same
unlocked browser profile.

### At-rest guarantee

Auto-key mode protects copied database material that lacks the
corresponding browser key store, but does **not** protect against a
user, malware, extension, or attacker with access to the active browser
profile/origin. Passphrase mode (Argon2id wrapping) is required for
protection against offline browser-profile copies, provided the app is
locked and the passphrase has not been entered. This limitation is
stated in the UI and here.

### Metadata and direct-connect exposure

The broker can associate the stable conversation ID with every
signaling attempt it observes while it is running, even if it retains
no logs. WebRTC peers normally learn each other's network candidates
and IP addresses. The deployment's own STUN listener necessarily
receives a client's source IP in order to return its NAT mapping, but
receives no room ID or application content and immediately discards
that request state. Fragment URLs are absent from HTTP requests but
remain bearer secrets that can leak through sharing, clipboard history,
screenshots, browser extensions, or malicious client-side code. No
telemetry reduces app-created disclosure; it cannot prevent platform,
network, or endpoint metadata.

### Build and endpoint trust

Cryptography in a browser cannot protect users served a malicious
build, nor an endpoint controlled by malware or a privileged extension.
Source inspection alone does not prove the deployed bytes match source.
Self-hosting or independently verified/reproducible release artifacts
are required for users whose threat model includes a malicious operator;
this remains outside v1 implementation scope.
