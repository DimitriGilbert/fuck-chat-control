import type { DataChannelTransport } from "./types";

/**
 * Receive-capable transport contract consumed by the orchestrator.
 *
 * `FrameTransport` (framing) is send-only. During the orchestrator's
 * handshake phase, inbound bytes are plaintext handshake messages, not
 * yet encrypted frames — so the orchestrator needs a transport that can
 * also deliver received bytes via {@link PeerTransport.setOnMessage}.
 *
 * After the handshake completes, the same underlying transport is handed
 * to `FrameSender` (it satisfies `FrameTransport`) and its inbound stream
 * is rerouted to `FrameReceiver.ingest`.
 *
 * `setOnDrain` is the orchestrator-facing alias for the underlying
 * `DataChannelTransport.setDrainListener`; see {@link toPeerTransport}.
 */
export interface PeerTransport {
  send(bytes: Uint8Array): void;
  readonly ready: boolean;
  readonly bufferedAmount: number;
  setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void;
  setOnDrain(handler: (() => void) | null): void;
  close(): void;
}

/**
 * Adapt a {@link DataChannelTransport} into a {@link PeerTransport}.
 *
 * `DataChannelTransport` structurally satisfies every member of
 * {@link PeerTransport} except the drain method name (it exposes
 * `setDrainListener`, framing depends on that name). This thin wrapper
 * maps `setOnDrain` → `setDrainListener` and passes everything else
 * through, keeping the framing-facing public surface stable.
 *
 * Generic over `T` so callers may keep a concrete adapter type (e.g. the
 * web `DataChannelTransport` class) through the adaptation while the
 * returned contract is always {@link PeerTransport}.
 */
export function toPeerTransport<T extends DataChannelTransport>(
  transport: T,
): PeerTransport {
  return {
    send: (bytes: Uint8Array): void => {
      transport.send(bytes);
    },
    get ready(): boolean {
      return transport.ready;
    },
    get bufferedAmount(): number {
      return transport.bufferedAmount;
    },
    setOnMessage: (handler: ((bytes: Uint8Array) => void) | null): void => {
      transport.setOnMessage(handler);
    },
    setOnDrain: (handler: (() => void) | null): void => {
      transport.setDrainListener(handler);
    },
    close: (): void => {
      transport.close();
    },
  };
}
