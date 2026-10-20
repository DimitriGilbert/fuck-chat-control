import { describe, expect, it } from "vitest";

import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group/types";
import type {
  GroupSummary,
  SessionSummary,
} from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";

import { buildUnifiedList } from "@/features/chat/ui/sidebar";

/**
 * Phase 7 (protocol-v2): the sidebar's unified list interleaves live groups
 * with the 1:1 records-∪-sessions merge. These tests pin the merge: every
 * live group gets a row (groups are runtime-only — there is no persisted
 * placeholder), ordering is most-recent-first across BOTH kinds, and the
 * kind-prefixed key keeps a group and a conversation with identical id
 * bytes from colliding.
 */

const ID_BYTES = 16;

function convId(n: number): ConversationId {
  const bytes = new Uint8Array(ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as ConversationId;
}

function groupId(n: number): GroupId {
  const bytes = new Uint8Array(ID_BYTES);
  new DataView(bytes.buffer).setUint32(12, n);
  return bytes as unknown as GroupId;
}

function makeRecord(id: ConversationId, createdAt = 0): ConversationRecord {
  return {
    id,
    createdAt,
    displayName: null,
    peer: null,
    authFailed: false,
    authFailedAt: null,
  };
}

function makeSummary(id: ConversationId, lastMessageAt: number | null = null): SessionSummary {
  return {
    id,
    label: "chat",
    connectionState: ConnectionState.Connected,
    unread: 0,
    lastMessagePreview: null,
    lastMessageAt,
    safetyNumberVerified: false,
    authFailed: false,
    authMode: AuthMode.SafetyNumberOnly,
  };
}

function makeGroup(n: number, lastMessageAt: number | null = null): GroupSummary {
  const id = groupId(n);
  let groupIdHex = "";
  for (const b of id) groupIdHex += b.toString(16).padStart(2, "0");
  return {
    groupId: id,
    groupIdHex,
    label: `group-${n}`,
    epoch: 1,
    memberCount: 2,
    connectedLinks: 1,
    isAuthor: true,
    unread: 0,
    lastMessagePreview: null,
    lastMessageAt,
    safetyNumberVerified: false,
  };
}

describe("buildUnifiedList (conversations + groups)", () => {
  it("returns an empty list when nothing exists", () => {
    expect(buildUnifiedList([], [], [])).toEqual([]);
  });

  it("lists a live group alongside conversations", () => {
    const entries = buildUnifiedList(
      [makeRecord(convId(1))],
      [makeSummary(convId(1))],
      [makeGroup(2)],
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind).sort()).toEqual(["conversation", "group"]);
  });

  it("orders both kinds most-recent-first, nulls last", () => {
    const entries = buildUnifiedList(
      [],
      [makeSummary(convId(1), 1_000)],
      [makeGroup(2, 2_000), makeGroup(3)],
    );
    expect(entries.map((e) => e.kind)).toEqual(["group", "conversation", "group"]);
  });

  it("a group and a conversation with identical id bytes do not collide", () => {
    const entries = buildUnifiedList([], [makeSummary(convId(7))], [makeGroup(7)]);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
    expect(entries.map((e) => e.key)).toContain(`c:${entries[0]!.key.slice(2)}`);
  });

  it("does not mutate its inputs", () => {
    const records = [makeRecord(convId(1))];
    const sessions = [makeSummary(convId(1))];
    const groups = [makeGroup(2)];
    const before = groups.slice();
    buildUnifiedList(records, sessions, groups);
    expect(groups).toEqual(before);
  });
});
