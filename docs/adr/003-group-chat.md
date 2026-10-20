# ADR 003: Group Chat as a Mesh of Pairwise v1 Links

Status: Accepted
Date: 2026-10-20

## Context

Protocol v1 is frozen and strictly pairwise. Every layer of the system —
the broker's two-seat rooms, the handshake transcript, the key schedule,
the safety number, and the frame codec — is defined for exactly two
identity keys. Users want group conversations, and there are only two
ways to get them: change the cryptographic core (a group ratchet or a
sender-key layer), or compose the pairwise primitive that already exists.

Changing the core is off the table. The v1 wire format is frozen; any
modification requires a version bump and a new ADR, and a group ratchet
(MLS, or a Signal-style sender-key scheme) would be a large new
cryptographic surface to design, audit, and maintain — the single most
dangerous place to move fast. The alternative is to treat a group as a
membership layer on top of unmodified v1 sessions: N members means a
full mesh of N·(N−1)/2 pairwise links, each an ordinary protocol-v1
conversation. Group semantics then reduce to two problems the frozen
protocol does not already solve: who is in the group (membership), and
how N peers signal each other (the broker's two-seat rooms do not scale).

This ADR records the decision to build groups that way, and the settled
defaults that come with it. The normative wire details live in
[protocol-v2-group.md](../architecture/protocol-v2-group.md); the
security consequences are stated in the
[threat model](../architecture/threat-model.md).

## Decision

A group is a full mesh of pairwise protocol-v1 sessions plus two new
pieces of machinery:

- **Author-signed membership list.** The group's author (the creator's
  identity key) maintains the canonical member list, signs each version
  with its identity key, and stamps it with a monotonically increasing
  epoch. The signed list is gossiped to members over a new
  `group_membership` control subtype carried inside ordinary encrypted
  v1 control frames on each pairwise link. Members verify the author
  signature and adopt the newest epoch.
- **peerId-addressed broker relay.** The broker protocol gains a `group`
  room mode: rooms seat up to `GROUP_MAX_MEMBERS` sockets instead of 2,
  each joiner picks an ephemeral 8-byte `peerId` at join time, and
  `offer`/`answer`/`ice` messages are addressed `to`/`from` peerIds
  rather than relayed to "the other seat". Pair-mode rooms are
  unchanged.

Each pair of members establishes a standard v1 conversation over its own
WebRTC data channel, using a pairwise conversation ID derived
deterministically from the group ID and the pair's identity keys, so the
frozen handshake codec, transcript, key schedule, and frame format run
byte-for-byte unchanged. Group text and file content is plain v1 frames
sent on every connected link; sender attribution is the link's
authenticated peer identity. No new transport cryptography is introduced.

### Settled decisions and defaults

- **No MLS, no sender-key layer.** Pure pairwise mesh. Group traffic is
  encrypted member↔member; there is no group-wide session key.
- **No history for new members.** A member sees messages from join-time
  forward. There is no history sync, catch-up, or key-sharing of past
  epochs.
- **One author-set PAKE code for the whole group.** The author mints a
  single 6-digit code at group creation; it is carried in the invitation
  fragment (`#<hex>~NNNNNN`, identical grammar to 1:1) and is used as
  the SPAKE2 password on _every_ pairwise handshake in the group. Groups
  created without a code are safety-number-only on every link, same as
  1:1.
- **No offline delivery.** A member who is offline misses messages; there
  is no store-and-forward anywhere in the system.
- **No total message ordering.** Per-sender ordering comes free from each
  link's sequence numbers; the UI sorts the merged stream by timestamp.
- **Env-configurable member cap.** `GROUP_MAX_MEMBERS` is a server env
  var (optional integer, default `DEFAULT_MAX_GROUP_MEMBERS = 8`, hard
  ceiling `MAX_GROUP_MEMBERS_HARD = 16`). The broker registry and the
  client-side group session take the configured value as an option;
  `/ice-config` serves it to the client. The hard ceiling bounds the env
  var itself so an operator cannot mint an unbounded room.
- **Author is the sole admin.** The author can remove members; nobody
  else can mint a membership list. Anyone holding the invitation link
  may join — identical bearer-link semantics to 1:1, where the link is
  the capability.
- **Members stay seated in the broker room** for the life of the group.
  Unlike 1:1 (where both peers `signalP2pOpen` and leave once the data
  channel opens), group members keep their broker seats so new members
  can join and dropped links can re-signal. The broker still holds only
  signaling metadata — never content.
- **Derived pairwise conversation IDs.** Each pair's v1 conversation ID
  is derived, not random, per the formula in the spec — deterministic so
  both sides compute the same value and each pair gets a stable safety
  number.

## Alternatives considered

- **MLS (RFC 9420) group messaging:** rejected. It is the right answer
  for large groups and gives real group forward secrecy, but it is an
  entire new protocol — a ratchet tree, new credential types, new
  delivery-service semantics — that cannot be built on the frozen v1
  codec. Far more cryptographic surface than this codebase can carry
  today; revisit only as a protocol v3 effort with its own ADR chain.
- **Sender-key scheme (Signal-style):** rejected. Cheaper fan-out than a
  mesh and a smaller spec than MLS, but it weakens security properties
  (a compromised sender key reads the whole group, and sender keys give
  no per-recipient deniability), still requires a new key-distribution
  layer, and still touches the frozen codec. It buys bandwidth
  efficiency we do not need at N ≤ 8.
- **Broker-mediated group fan-out (server-side rooms that relay
  ciphertext):** rejected. It would put message ciphertext on the broker
  for the first time, contradicting the architecture's "the broker is a
  signaling relay only" property and giving the server a store it never
  had. The mesh keeps the broker byte-for-byte out of the data path.
- **Random per-link conversation IDs exchanged at handshake time:**
  rejected. The derived ID is deterministic, needs no extra negotiation
  round, and — because it is bound to the two identity keys — cannot be
  confused with a different pair's session in the same group.
- **Paxos/Raft or multi-admin membership:** rejected. A single
  authoritative signer is the simplest correct model at this scale; the
  alternative distributes a trust decision we would rather localize in
  the author and audit in one place.

## Tradeoffs

- **Quadratic links.** N members run N·(N−1)/2 WebRTC connections and
  duplicate every outbound frame N−1 times. At the default cap of 8 that
  is 28 links and 7 sends per message — acceptable; at the hard ceiling
  of 16 it is 120 links, which is why the ceiling exists and why
  real-time media is out of scope.
- **No group-level forward secrecy.** Removing a member does not revoke
  keys for epochs it saw; a removed member keeps read access to past
  traffic on its links. This is stated plainly in the threat model —
  the mesh has no mechanism to re-key the group.
- **Weaker authentication than 1:1 in practice.** One group-wide PAKE
  code is reused across all links (so intercepting the code once
  undermines every link), and out-of-band verification is a single group
  safety number per epoch rather than per pair. Both are deliberate
  usability trades at this group size.

## Consequences

- **N−1 peer IP disclosure.** Each member holds WebRTC connections to
  every other member and therefore learns N−1 peers' IP addresses,
  instead of 1 in the 1:1 case. The threat model is updated accordingly.
- **Persistent broker seats.** Group members keep their broker
  connections open for the group's lifetime. This exposes new metadata
  to the broker: the room ID (equal to the group ID) plus the online
  presence of up to `GROUP_MAX_MEMBERS` sockets, with join/leave timing.
  Still no content — the broker relays only signaling — but it is a real
  widening of the metadata surface versus the 1:1 case where both seats
  vacate once the channel opens.
- **Author equivocation is detectable, not preventable.** The author can
  sign two conflicting member lists at the same epoch and deliver
  different lists to different members (a split-view attack). The
  signature makes equivocation attributable: any member who receives two
  valid signed lists for the same epoch has cryptographic proof of
  author misbehavior, and cross-member gossip over the pairwise links
  surfaces conflicting signed lists to honest members. Prevention would
  require a consensus or transparency mechanism — out of scope.
- **Safety-number verification scales poorly with N.** The group safety
  number covers the whole member list at one epoch and changes on every
  membership change, so re-verification is needed after each join or
  removal; and the reused PAKE code means a leak of the code weakens
  every link at once. These are the honest costs of the mesh, and they
  bound the group sizes the design is good for.
- **The frozen protocol is untouched.** All v1 files, wire formats, and
  behaviors are byte-compatible; every group addition is additive (new
  optional join fields, two new control subtypes valid only on group
  links, new spec document). Any future change to v1 itself still
  requires a version bump and a new ADR.

## Non-goals

Explicitly out of scope for this design:

- MLS or any group ratchet.
- Sender-key / shared group session keys.
- Offline or store-and-forward delivery.
- Total (or causal) ordering of group messages.
- History sync for new members, or any sharing of pre-join keys.
