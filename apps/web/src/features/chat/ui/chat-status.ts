import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import type { ConversationMessage } from "@fuck-eu-chat-control/chat-runtime/store";

/**
 * Human label for each connection state. Used by the status bar and the
 * landing page waiting indicator so the vocabulary stays in one place.
 */
export const CONNECTION_STATE_LABELS: ReadonlyRecord<ConnectionState, string> = {
  [ConnectionState.Idle]: "Idle",
  [ConnectionState.Waiting]: "Waiting for peer",
  [ConnectionState.Signaling]: "Signaling",
  [ConnectionState.Handshaking]: "Handshaking",
  [ConnectionState.Verifying]: "Verifying",
  [ConnectionState.Connected]: "Connected",
  [ConnectionState.Disconnected]: "Disconnected",
};

export type ConnectionStateVariant =
  | "default"
  | "secondary"
  | "muted"
  | "tinted"
  | "outline"
  | "ghost"
  | "destructive";

/**
 * Visual variant for the status pill. Disconnected is destructive so the
 * user notices a dropped peer; the in-flight handshake stages are muted; the
 * connected state is the default primary.
 */
export const CONNECTION_STATE_VARIANTS: ReadonlyRecord<ConnectionState, ConnectionStateVariant> = {
  [ConnectionState.Idle]: "outline",
  [ConnectionState.Waiting]: "tinted",
  [ConnectionState.Signaling]: "tinted",
  [ConnectionState.Handshaking]: "tinted",
  [ConnectionState.Verifying]: "tinted",
  [ConnectionState.Connected]: "default",
  [ConnectionState.Disconnected]: "destructive",
};

/**
 * Partitions messages by calendar day so the transcript can render a
 * `Marker` separator between days. Uses the local date string so the
 * grouping matches the user's wall clock.
 *
 * Generic over the message shape (only `timestamp` is consumed) so both the
 * 1:1 {@link ConversationMessage} transcript and the group's attributed
 * {@link GroupChatMessage} transcript (protocol-v2) share the bucketing.
 */
export interface DayBucket<T extends { readonly timestamp: number } = ConversationMessage> {
  readonly key: string;
  readonly label: string;
  readonly messages: readonly T[];
}

export function bucketByDay<T extends { readonly timestamp: number }>(
  messages: readonly T[],
): readonly DayBucket<T>[] {
  const buckets: DayBucket<T>[] = [];
  for (const message of messages) {
    const key = dayKey(message.timestamp);
    const last = buckets[buckets.length - 1];
    if (last !== undefined && last.key === key) {
      buckets[buckets.length - 1] = {
        ...last,
        messages: [...last.messages, message],
      };
    } else {
      buckets.push({ key, label: dayLabel(message.timestamp), messages: [message] });
    }
  }
  return buckets;
}

function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Utility type — a record whose values are all of type V. */
export type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };
