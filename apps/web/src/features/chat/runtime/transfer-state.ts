/**
 * Per-transfer UI state for the chat session snapshot. Mirrors the framing
 * layer's progress in a render-friendly shape: id, name, mimeType, size, the
 * direction (sent from us vs received from peer), how many bytes have crossed
 * so far, a coarse status, and an optional error string.
 *
 * `bytesTransferred` is clamped to `[0, size]` by the reducer so the UI can
 * trust it for the progress bar width.
 */
export interface TransferState {
  readonly id: number;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly direction: "sent" | "received";
  readonly bytesTransferred: number;
  readonly status: "queued" | "sending" | "receiving" | "complete" | "cancelled" | "error";
  readonly error?: string;
}

/**
 * Events the controller emits at the framing/orchestrator seams. The reducer
 * is the single place that maps "what happened" into "what the snapshot now
 * says," so React consumers read a uniform shape.
 *
 * `start` is the only event that introduces a new transfer; every other event
 * looks up by id and returns the same array reference if the id is unknown
 * (late events after teardown must not throw or mutate).
 */
export type TransferEvent =
  | {
      readonly type: "start";
      readonly id: number;
      readonly name: string;
      readonly mimeType: string;
      readonly size: number;
      readonly direction: "sent" | "received";
      readonly queued?: boolean;
    }
  | { readonly type: "progress"; readonly id: number; readonly bytesTransferred: number }
  | { readonly type: "complete"; readonly id: number }
  | { readonly type: "cancelled"; readonly id: number }
  | { readonly type: "error"; readonly id: number; readonly error: string };

/**
 * Fold one event into the transfer list. Pure: returns a new array iff
 * something changed, otherwise the same reference. A late event for an
 * unknown id (or for a transfer already in a terminal state) is a no-op so
 * the snapshot stays stable across races.
 */
export function applyTransferEvent(
  state: readonly TransferState[],
  event: TransferEvent,
): readonly TransferState[] {
  if (event.type === "start") {
    const existing = state.find((t) => t.id === event.id);
    if (existing !== undefined) return state;
    const status: TransferState["status"] =
      event.queued === true ? "queued" : event.direction === "sent" ? "sending" : "receiving";
    const next: TransferState = {
      id: event.id,
      name: event.name,
      mimeType: event.mimeType,
      size: event.size,
      direction: event.direction,
      bytesTransferred: 0,
      status,
    };
    return [...state, next];
  }

  const idx = state.findIndex((t) => t.id === event.id);
  if (idx === -1) return state;
  const current = state[idx]!;
  if (isTerminal(current.status) && event.type !== "error") {
    // Once complete/cancelled/error, ignore progress/complete/cancelled noise.
    // An error after completion is still ignored: a late hash-mismatch report
    // on an already-complete transfer would only confuse the UI.
    return state;
  }

  let updated: TransferState;
  switch (event.type) {
    case "progress":
      updated = {
        ...current,
        bytesTransferred: clamp(current.size, event.bytesTransferred),
        status: current.status === "queued" ? activeStatus(current.direction) : current.status,
      };
      break;
    case "complete":
      updated = { ...current, status: "complete", bytesTransferred: current.size };
      break;
    case "cancelled":
      updated = { ...current, status: "cancelled" };
      break;
    case "error":
      updated = { ...current, status: "error", error: event.error };
      break;
  }
  const next = state.slice();
  next[idx] = updated;
  return next;
}

function isTerminal(status: TransferState["status"]): boolean {
  return status === "complete" || status === "cancelled" || status === "error";
}

function activeStatus(direction: "sent" | "received"): TransferState["status"] {
  return direction === "sent" ? "sending" : "receiving";
}

function clamp(size: number, value: number): number {
  if (value < 0) return 0;
  if (value > size) return size;
  return value;
}
