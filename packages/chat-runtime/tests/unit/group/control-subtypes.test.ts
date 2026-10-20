import { describe, expect, it } from "vitest";

import { FramingError, FramingErrorCode } from "@fuck-eu-chat-control/chat-runtime/framing";
import type { FrameReceiverHandlers } from "@fuck-eu-chat-control/chat-runtime/framing";
import { ControlSubtype, FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import { forgeFrame, makePair, utf8 } from "../framing/_helpers";

function collectHandlers() {
  const controls: { subtype: ControlSubtype; payload: Uint8Array }[] = [];
  const handlers: FrameReceiverHandlers = {
    onText: () => {},
    onControl: (subtype, payload) => {
      controls.push({ subtype, payload: new Uint8Array(payload) });
    },
    onFileComplete: () => {},
  };
  return { handlers, controls };
}

async function expectFramingError(
  promise: Promise<unknown>,
  code: FramingErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FramingError);
    expect((err as FramingError).code).toBe(code);
    return;
  }
  throw new Error(`expected FramingError ${code}, but no error was thrown`);
}

describe("group control subtypes gating (protocol-v2 §4.1)", () => {
  it("sender rejects group_membership (0x07) on a pair-mode link", async () => {
    const { handlers } = collectHandlers();
    const { sender } = await makePair(handlers);
    await expectFramingError(
      sender.sendControl(ControlSubtype.GroupMembership, new Uint8Array(0)),
      FramingErrorCode.UnknownControlSubtype,
    );
  });

  it("sender rejects group_membership_request (0x08) on a pair-mode link", async () => {
    const { handlers } = collectHandlers();
    const { sender } = await makePair(handlers);
    await expectFramingError(
      sender.sendControl(ControlSubtype.GroupMembershipRequest, new Uint8Array(0)),
      FramingErrorCode.UnknownControlSubtype,
    );
  });

  it("sender rejects both group subtypes when the flag is explicitly false", async () => {
    const { handlers } = collectHandlers();
    const { sender } = await makePair(handlers, { allowGroupControlSubtypes: false });
    // The sendControl check throws before any state is touched, so both
    // rejections can be exercised on the same sender.
    await expectFramingError(
      sender.sendControl(ControlSubtype.GroupMembership, new Uint8Array(0)),
      FramingErrorCode.UnknownControlSubtype,
    );
    await expectFramingError(
      sender.sendControl(ControlSubtype.GroupMembershipRequest, new Uint8Array(0)),
      FramingErrorCode.UnknownControlSubtype,
    );
  });

  it("receiver terminal-errors on forged 0x07/0x08 frames when the flag is explicitly false", async () => {
    const { handlers } = collectHandlers();
    const pair = await makePair(handlers, { allowGroupControlSubtypes: false });
    const subtypes = [
      ControlSubtype.GroupMembership,
      ControlSubtype.GroupMembershipRequest,
    ] as const;
    // Distinct sequence numbers: decrypting the first forged frame consumed
    // sequence 0 in the replay window before handleControl threw.
    for (let i = 0; i < subtypes.length; i++) {
      const frame = await forgeFrame(
        pair.recvKeys.recvKey,
        pair.peerSessionId,
        i,
        FrameType.Control,
        0,
        0,
        new Uint8Array([subtypes[i], 0xaa]),
      );
      await expectFramingError(pair.receiver.ingest(frame), FramingErrorCode.UnknownControlSubtype);
    }
  });

  it("receiver terminal-errors on a forged 0x07 control frame in pair mode", async () => {
    const { handlers } = collectHandlers();
    const pair = await makePair(handlers);
    const frame = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      0,
      FrameType.Control,
      0,
      0,
      new Uint8Array([ControlSubtype.GroupMembership, 0xaa]),
    );
    await expectFramingError(pair.receiver.ingest(frame), FramingErrorCode.UnknownControlSubtype);
  });

  it("receiver terminal-errors on a forged 0x08 control frame in pair mode", async () => {
    const { handlers } = collectHandlers();
    const pair = await makePair(handlers);
    const frame = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      0,
      FrameType.Control,
      0,
      0,
      new Uint8Array([ControlSubtype.GroupMembershipRequest, 0xaa]),
    );
    await expectFramingError(pair.receiver.ingest(frame), FramingErrorCode.UnknownControlSubtype);
  });

  it("receiver accepts a forged 0x07 control frame when the flag is set", async () => {
    const { handlers, controls } = collectHandlers();
    const pair = await makePair(handlers, { allowGroupControlSubtypes: true });
    const frame = await forgeFrame(
      pair.recvKeys.recvKey,
      pair.peerSessionId,
      0,
      FrameType.Control,
      0,
      0,
      new Uint8Array([ControlSubtype.GroupMembership, 0xaa, 0xbb]),
    );
    await pair.receiver.ingest(frame);
    expect(controls.length).toBe(1);
    expect(controls[0].subtype).toBe(ControlSubtype.GroupMembership);
    expect(Array.from(controls[0].payload)).toEqual([0xaa, 0xbb]);
  });

  it("sender accepts and delivers group subtypes end-to-end with the flag", async () => {
    const { handlers, controls } = collectHandlers();
    const { sender, transport } = await makePair(handlers, {
      allowGroupControlSubtypes: true,
    });
    await sender.sendControl(ControlSubtype.GroupMembership, utf8("list"));
    await sender.sendControl(ControlSubtype.GroupMembershipRequest, new Uint8Array(0));
    await transport.ingestSettled;
    expect(controls.length).toBe(2);
    expect(controls[0].subtype).toBe(ControlSubtype.GroupMembership);
    expect(new TextDecoder().decode(controls[0].payload)).toBe("list");
    expect(controls[1].subtype).toBe(ControlSubtype.GroupMembershipRequest);
    expect(controls[1].payload.length).toBe(0);
  });

  it("v1 subtypes keep working when the group flag is set", async () => {
    const { handlers, controls } = collectHandlers();
    const { sender, transport } = await makePair(handlers, {
      allowGroupControlSubtypes: true,
    });
    await sender.sendControl(ControlSubtype.Leave, utf8("bye"));
    await transport.ingestSettled;
    expect(controls.length).toBe(1);
    expect(controls[0].subtype).toBe(ControlSubtype.Leave);
  });
});
