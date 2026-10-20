import { describe, expect, it } from "vitest";

import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { GroupMemberView } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

import {
  clampUtf8Bytes,
  memberDisplayLabel,
  memberLinkLabel,
  memberLinkTone,
  senderLabel,
  sortGroupMembers,
} from "@/features/chat/ui/group-members";

/**
 * Phase 7b (protocol-v2): pins for the member-sheet display helpers —
 * author-first-then-name ordering, the display-name/key-prefix fallback
 * shared by member rows and sender captions, the three-way link-status
 * vocabulary, and the UTF-8 byte clamp on the editable display name.
 */

const PUB_BYTES = 65;

function pubKey(fill: number): { pub: PublicKey; hex: string } {
  const bytes = new Uint8Array(PUB_BYTES).fill(fill);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return { pub: bytes as unknown as PublicKey, hex };
}

function member(fill: number, overrides: Partial<GroupMemberView> = {}): GroupMemberView {
  const { pub, hex } = pubKey(fill);
  return {
    identityPub: pub,
    identityPubHex: hex,
    isAuthor: false,
    isSelf: false,
    displayName: "",
    linkState: ConnectionState.Connected,
    ...overrides,
  };
}

describe("memberDisplayLabel", () => {
  it("prefers the announced display name", () => {
    expect(memberDisplayLabel(member(0x0a, { displayName: "Alice" }))).toBe("Alice");
  });

  it("falls back to the short identity-key prefix when unnamed", () => {
    expect(memberDisplayLabel(member(0xab))).toBe("abababab…");
  });
});

describe("senderLabel", () => {
  const members = [member(0x01, { displayName: "Bob" }), member(0x02)];

  it("resolves a listed sender to their display name", () => {
    expect(senderLabel(pubKey(0x01).pub, members)).toBe("Bob");
  });

  it("resolves an unnamed listed sender to their key prefix", () => {
    expect(senderLabel(pubKey(0x02).pub, members)).toBe("02020202…");
  });

  it("falls back to the raw key prefix for a sender no longer in the list", () => {
    expect(senderLabel(pubKey(0x09).pub, members)).toBe("09090909…");
  });
});

describe("sortGroupMembers", () => {
  it("puts the author first even when another name sorts earlier", () => {
    const sorted = sortGroupMembers([
      member(0x01, { displayName: "Aaron" }),
      member(0x02, { displayName: "Zed", isAuthor: true }),
      member(0x03, { displayName: "Bob" }),
    ]);
    expect(sorted.map((m) => m.displayName)).toEqual(["Zed", "Aaron", "Bob"]);
  });

  it("orders by display label — announced names and key prefixes share one order", () => {
    const sorted = sortGroupMembers([
      member(0x09, { displayName: "Carol" }),
      member(0x02), // label "02020202…" — sorts before "Carol"
      member(0x03, { displayName: "Alice" }),
    ]);
    expect(sorted.map((m) => memberDisplayLabel(m))).toEqual(["02020202…", "Alice", "Carol"]);
  });

  it("breaks equal labels on the identity hex so ordering is stable", () => {
    const a = member(0x04, { displayName: "Same" });
    const b = member(0x05, { displayName: "Same" });
    const sorted = sortGroupMembers([b, a]);
    expect(sorted.map((m) => m.identityPubHex)).toEqual([a.identityPubHex, b.identityPubHex]);
  });

  it("does not mutate the input array", () => {
    const input = [member(0x03, { displayName: "Bob" }), member(0x02, { displayName: "Al" })];
    const before = input.slice();
    sortGroupMembers(input);
    expect(input).toEqual(before);
  });
});

describe("memberLinkLabel / memberLinkTone", () => {
  it("maps Connected to connected", () => {
    expect(memberLinkLabel(ConnectionState.Connected)).toBe("Connected");
    expect(memberLinkTone(ConnectionState.Connected)).toBe("connected");
  });

  it("maps every in-flight handshake state to connecting", () => {
    for (const state of [
      ConnectionState.Waiting,
      ConnectionState.Signaling,
      ConnectionState.Handshaking,
      ConnectionState.Verifying,
    ]) {
      expect(memberLinkLabel(state)).toBe("Connecting");
      expect(memberLinkTone(state)).toBe("connecting");
    }
  });

  it("maps Idle/Disconnected to disconnected", () => {
    for (const state of [ConnectionState.Idle, ConnectionState.Disconnected]) {
      expect(memberLinkLabel(state)).toBe("Disconnected");
      expect(memberLinkTone(state)).toBe("disconnected");
    }
  });

  it("maps a null link (self / no link) to the disconnected reading", () => {
    expect(memberLinkLabel(null)).toBe("No link");
    expect(memberLinkTone(null)).toBe("disconnected");
  });
});

describe("clampUtf8Bytes", () => {
  it("returns the input unchanged under the cap", () => {
    expect(clampUtf8Bytes("hello", 32)).toBe("hello");
  });

  it("truncates at a code-point boundary — never splits a surrogate pair", () => {
    // "a" = 1 byte, "😀" = 4 bytes: the emoji cannot start at byte 1 with a
    // 4-byte cap, so the clamp ends after "a" rather than emitting half a
    // surrogate pair.
    expect(clampUtf8Bytes("a😀b", 4)).toBe("a");
    expect(clampUtf8Bytes("a😀b", 5)).toBe("a😀");
  });

  it("counts UTF-8 bytes, not UTF-16 units", () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: a 3-byte cap keeps one of two.
    expect(clampUtf8Bytes("éé", 3)).toBe("é");
  });
});
