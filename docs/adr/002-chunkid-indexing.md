# ADR 002: `chunkId` Is a 0-Based Index

Status: Accepted
Date: 2026-10-16

## Context

The frame header carries a 4-byte big-endian `chunk ID` field (protocol spec
§8.1). The spec's original wording described it as "`0` when the frame is not
a chunk", which read literally suggests `0` only ever means "absent".

The implementation never treated it that way. The framing sender emits
`file_chunk` frames with `chunkId` starting at `0` — `0` is the id of the
first chunk of every transfer (`framing/sender.ts`). The receiver
bounds-checks the field against the manifest's declared chunk count as a
0-based array index (`0 <= chunkId < chunkCount`, `framing/receiver.ts`). So
a `file_chunk` frame with `chunkId = 0` is not only legitimate, it is on the
wire for every file transfer.

The ambiguous wording is hazardous in both directions: a "hardening" change
that rejected `chunkId = 0` on chunk frames would break every file transfer,
and a "cleanup" that re-based the index to 1 would be a wire-format change to
a frozen protocol.

## Decision

`chunkId` is a **0-based index** into the transfer's chunk sequence, as the
implementation has always behaved. `0` is the absent-marker only for frame
types that are not chunks — `text`, `control`, and the manifest types
(`file_manifest`, `media_manifest`), where `chunkId` must be `0` and carries
no index meaning. For `file_chunk` (and the reserved `media_chunk`) any value
in `0..=UINT32_MAX` is a well-formed field; range validation against the
manifest's `chunkCount` is the receiver's job, not the codec's.

This is a documentation clarification, not a wire-format or semantic change.
The codec's field-relation validation (`assertFrameFieldRelations` in
`protocol/codec.ts`) already accepts `chunkId = 0` on chunk frames and already
requires `chunkId = 0` on `text`, `control`, and manifest frames. The spec
wording in §8.1/§8.2 was amended to say so, and a codec unit test now pins
`file_chunk` + `chunkId = 0` round-tripping as valid so a future refactor
cannot silently reject it.

## Alternatives considered

- Re-base `chunkId` to a 1-based index so `0` unambiguously means "absent"
  for every frame type: rejected. It would change the wire format of a frozen
  protocol, touch both the sender's indexing and the receiver's bounds check,
  and buy nothing — the field relations are already validated per frame type.
- Reject `chunkId = 0` on chunk frames as invalid: rejected. It would make
  the first chunk of every transfer undeliverable. The codec must not
  special-case a value the pipeline produces on every send.
- Leave the spec wording as-is: rejected. The ambiguity already survived one
  review cycle and invites a breaking "fix" by a future reader.

## Tradeoffs

- The absent-marker and the index-0 case share a value, distinguished only by
  the frame type. That is inherent to the frozen 50-byte header layout; the
  per-frame-type field-relation table (§8.2) is what disambiguates it, and
  this ADR exists to make that explicit.
- Receivers must still bounds-check `chunkId` against the manifest's declared
  `chunkCount` — the codec accepts `chunkId = 5000` on a `file_chunk` whose
  transfer only has 3 chunks, and the receiver drops it. The ADR clarifies
  encoding semantics; it does not weaken application-level validation.

## Consequences

- The spec (§8.1/§8.2) now states the 0-based indexing explicitly and links
  here.
- `protocol/codec.ts` keeps accepting `chunkId = 0` on `file_chunk`/
  `media_chunk` frames; a unit test pins the behavior.
- Any proposal to change `chunkId` indexing or to reserve `0` on chunk
  frames requires a new ADR and a wire-format version bump, per the protocol
  freeze.
