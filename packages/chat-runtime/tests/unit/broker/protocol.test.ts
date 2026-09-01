import { describe, expect, it } from "vitest";

import {
  BROKER_MESSAGE_MAX_BYTES,
  formatMessage,
  forward,
  parseMessage,
} from "@fuck-eu-chat-control/chat-runtime/broker/protocol";
import type { BrokerMessage } from "@fuck-eu-chat-control/chat-runtime/broker/protocol";
import { MockBrokerSocket } from "./_helpers";

function roomId(seed: number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += ((seed * 31 + i * 7) & 0xff).toString(16).padStart(2, "0");
  }
  return hex.slice(0, 32);
}

describe("parseMessage — valid messages", () => {
  it("parses a join message", () => {
    const id = roomId(1);
    const msg = parseMessage(JSON.stringify({ t: "join", roomId: id }));
    expect(msg).toEqual({ kind: "join", roomId: id });
  });

  it("parses an offer message", () => {
    const msg = parseMessage(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "x" } }));
    expect(msg).toEqual({ kind: "offer", sdp: { type: "offer", sdp: "x" } });
  });

  it("parses an answer message", () => {
    const msg = parseMessage(JSON.stringify({ t: "answer", sdp: { type: "answer", sdp: "y" } }));
    expect(msg).toEqual({ kind: "answer", sdp: { type: "answer", sdp: "y" } });
  });

  it("parses an ice message", () => {
    const candidate = { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 };
    const msg = parseMessage(JSON.stringify({ t: "ice", candidate }));
    expect(msg).toEqual({ kind: "ice", candidate });
  });

  it("parses a leave message", () => {
    const id = roomId(2);
    const msg = parseMessage(JSON.stringify({ t: "leave", roomId: id }));
    expect(msg).toEqual({ kind: "leave", roomId: id });
  });
});

describe("parseMessage — rejections", () => {
  it("rejects non-JSON input", () => {
    expect(parseMessage("not json")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseMessage("")).toBeNull();
  });

  it("rejects a JSON value that is not an object", () => {
    expect(parseMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseMessage(JSON.stringify("string"))).toBeNull();
    expect(parseMessage(JSON.stringify(42))).toBeNull();
  });

  it("rejects an object with an unknown type tag", () => {
    expect(parseMessage(JSON.stringify({ t: "unknown", roomId: roomId(3) }))).toBeNull();
  });

  it("rejects an object missing the type tag", () => {
    expect(parseMessage(JSON.stringify({ roomId: roomId(4) }))).toBeNull();
  });

  it("rejects an oversized message", () => {
    const huge = "x".repeat(BROKER_MESSAGE_MAX_BYTES + 1);
    expect(parseMessage(JSON.stringify({ t: "offer", sdp: huge }))).toBeNull();
  });

  it("rejects join/leave with a malformed roomId", () => {
    expect(parseMessage(JSON.stringify({ t: "join", roomId: "bad" }))).toBeNull();
    expect(parseMessage(JSON.stringify({ t: "leave", roomId: "bad" }))).toBeNull();
  });

  it("rejects join missing roomId", () => {
    expect(parseMessage(JSON.stringify({ t: "join" }))).toBeNull();
  });

  it("rejects offer/answer missing sdp", () => {
    expect(parseMessage(JSON.stringify({ t: "offer" }))).toBeNull();
    expect(parseMessage(JSON.stringify({ t: "answer" }))).toBeNull();
  });

  it("rejects ice missing candidate", () => {
    expect(parseMessage(JSON.stringify({ t: "ice" }))).toBeNull();
  });
});

describe("formatMessage", () => {
  it("round-trips through parseMessage for every message kind", () => {
    const cases: BrokerMessage[] = [
      { kind: "join", roomId: roomId(10) },
      { kind: "offer", sdp: { type: "offer", sdp: "abc" } },
      { kind: "answer", sdp: { type: "answer", sdp: "def" } },
      { kind: "ice", candidate: { candidate: "c", sdpMid: null } },
      { kind: "leave", roomId: roomId(11) },
    ];
    for (const msg of cases) {
      expect(parseMessage(formatMessage(msg))).toEqual(msg);
    }
  });
});

describe("forward", () => {
  it("relays an offer to the other peer opaquely", () => {
    const peer = new MockBrokerSocket();
    forward(peer, { kind: "offer", sdp: { type: "offer", sdp: "opaque" } });
    expect(peer.sent).toHaveLength(1);
    expect(parseMessage(peer.sent[0])).toEqual({
      kind: "offer",
      sdp: { type: "offer", sdp: "opaque" },
    });
  });

  it("relays an answer to the other peer opaquely", () => {
    const peer = new MockBrokerSocket();
    forward(peer, { kind: "answer", sdp: { type: "answer", sdp: "opaque" } });
    expect(peer.sent).toHaveLength(1);
  });

  it("relays an ice candidate to the other peer opaquely", () => {
    const peer = new MockBrokerSocket();
    forward(peer, { kind: "ice", candidate: { candidate: "k" } });
    expect(peer.sent).toHaveLength(1);
  });

  it("does not relay join messages", () => {
    const peer = new MockBrokerSocket();
    forward(peer, { kind: "join", roomId: roomId(20) });
    expect(peer.sent).toHaveLength(0);
  });

  it("does not relay leave messages", () => {
    const peer = new MockBrokerSocket();
    forward(peer, { kind: "leave", roomId: roomId(21) });
    expect(peer.sent).toHaveLength(0);
  });
});

describe("no application-frame message type exists", () => {
  it("the BrokerMessage union has exactly the five signaling kinds", () => {
    const kinds: BrokerMessage["kind"][] = ["join", "offer", "answer", "ice", "leave"];
    expect(new Set(kinds).size).toBe(5);
    expect(kinds).toEqual(["join", "offer", "answer", "ice", "leave"]);
  });
});
