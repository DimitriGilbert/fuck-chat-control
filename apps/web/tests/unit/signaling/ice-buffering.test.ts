import { describe, expect, it } from "vitest";

import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";
import type { IceCandidate } from "@fuck-eu-chat-control/chat-runtime/transport/types";

/**
 * Test double for `RTCPeerConnection` that records every interaction and
 * lets the test observe (and control) the order in which the adapter applies
 * descriptions and ICE candidates. Specifically: `remoteDescription` starts
 * as `null` (mimicking the browser before setRemoteDescription settles) and
 * only becomes non-null after the test (or the adapter) calls
 * setRemoteDescription.
 */
class FakeRtcPeerConnection {
  public remoteDescription: RTCSessionDescription | null = null;
  public localDescription: RTCSessionDescription | null = null;
  public readonly addCandidateLog: IceCandidate[] = [];
  public readonly addCandidateOrder: string[] = [];
  public readonly setRemoteLog: RTCSessionDescriptionInit[] = [];
  // When true, the next addIceCandidate rejects — used to verify the adapter
  // swallows late/invalid candidates during the buffer drain.
  public rejectNextAddIceCandidate = false;
  // When true, every addIceCandidate rejects — used to verify a buffered
  // candidate that turns out invalid does not surface.
  public rejectAllAddIceCandidates = false;
  public closed = false;

  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    // The adapter subscribes to icecandidate / connectionstatechange /
    // datachannel; the ICE-buffering tests do not drive any of these.
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "fake-offer-sdp" };
  }

  public async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "fake-answer-sdp" };
  }

  public async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc as unknown as RTCSessionDescription;
  }

  public async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.setRemoteLog.push(desc);
    this.remoteDescription = desc as unknown as RTCSessionDescription;
  }

  public async addIceCandidate(candidate: IceCandidate): Promise<void> {
    this.addCandidateOrder.push(
      this.remoteDescription === null ? "pre-remote" : "post-remote",
    );
    this.addCandidateLog.push(candidate);
    if (this.rejectAllAddIceCandidates || this.rejectNextAddIceCandidate) {
      this.rejectNextAddIceCandidate = false;
      throw new Error("InvalidStateError: candidate applied against stale description");
    }
  }

  public createDataChannel(_label: string): unknown {
    throw new Error("not used by ICE-buffering tests");
  }

  public close(): void {
    this.closed = true;
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

function installFakeRtc(): FakeRtcPeerConnection {
  const instance = new FakeRtcPeerConnection();
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function () {
    return instance;
  };
  return instance;
}

function restoreRtc(): void {
  if (originalRtc === undefined) {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  } else {
    (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = originalRtc;
  }
}

describe("WebRtcAdapter — ICE candidate buffering pre-remote-description", () => {
  it("buffers ICE candidates that arrive before setRemoteDescription resolves, then drains them in order", async () => {
    const fakePc = installFakeRtc();
    try {
      const adapter = new WebRtcAdapter();
      expect(fakePc.remoteDescription).toBeNull();

      // Three candidates arrive BEFORE the remote description. Each must be
      // buffered (not passed to the underlying RTCPeerConnection, which
      // would reject them with InvalidStateError).
      const earlyA: IceCandidate = { candidate: "early-a", sdpMid: "0" };
      const earlyB: IceCandidate = { candidate: "early-b", sdpMid: "0" };
      const earlyC: IceCandidate = { candidate: "early-c", sdpMid: "0" };

      await adapter.addIceCandidate(earlyA);
      await adapter.addIceCandidate(earlyB);
      await adapter.addIceCandidate(earlyC);

      // Nothing has been forwarded yet.
      expect(fakePc.addCandidateLog).toEqual([]);
      expect(fakePc.addCandidateOrder).toEqual([]);

      // Now the remote description arrives. The adapter must drain the
      // buffered candidates in FIFO order, each through the underlying
      // addIceCandidate.
      await adapter.setRemoteDescription({ type: "offer", sdp: "remote-sdp" });

      expect(fakePc.remoteDescription).not.toBeNull();
      expect(fakePc.addCandidateLog).toEqual([earlyA, earlyB, earlyC]);
      // Each drain call happens AFTER remoteDescription was set.
      expect(fakePc.addCandidateOrder).toEqual(["post-remote", "post-remote", "post-remote"]);
    } finally {
      restoreRtc();
    }
  });

  it("forwards ICE candidates directly to the peer connection once a remote description is in place", async () => {
    const fakePc = installFakeRtc();
    try {
      const adapter = new WebRtcAdapter();

      await adapter.setRemoteDescription({ type: "offer", sdp: "remote-sdp" });
      expect(fakePc.remoteDescription).not.toBe(null);

      const later: IceCandidate = { candidate: "later", sdpMid: "0" };
      await adapter.addIceCandidate(later);

      expect(fakePc.addCandidateLog).toEqual([later]);
    } finally {
      restoreRtc();
    }
  });

  it("swallows late/invalid candidates during the drain so a single bad candidate never fails the handshake", async () => {
    const fakePc = installFakeRtc();
    try {
      const adapter = new WebRtcAdapter();

      // Buffer three candidates; the middle one will be rejected by the
      // underlying addIceCandidate during the drain.
      const earlyA: IceCandidate = { candidate: "early-a", sdpMid: "0" };
      const earlyB: IceCandidate = { candidate: "early-b", sdpMid: "0" };
      const earlyC: IceCandidate = { candidate: "early-c", sdpMid: "0" };
      await adapter.addIceCandidate(earlyA);
      // The next addIceCandidate call (the first drain attempt) will reject.
      fakePc.rejectNextAddIceCandidate = true;
      await adapter.addIceCandidate(earlyB);
      await adapter.addIceCandidate(earlyC);

      // setRemoteDescription must NOT reject even though one of the drained
      // candidates is rejected by the underlying RTCPeerConnection.
      await expect(
        adapter.setRemoteDescription({ type: "offer", sdp: "remote-sdp" }),
      ).resolves.toBeUndefined();

      // All three candidates were attempted; the bad one was swallowed but
      // the others still went through.
      expect(fakePc.addCandidateLog).toEqual([earlyA, earlyB, earlyC]);
    } finally {
      restoreRtc();
    }
  });

  it("clears the buffer after draining so a second setRemoteDescription does not re-apply old candidates", async () => {
    const fakePc = installFakeRtc();
    try {
      const adapter = new WebRtcAdapter();

      const early: IceCandidate = { candidate: "early", sdpMid: "0" };
      await adapter.addIceCandidate(early);

      await adapter.setRemoteDescription({ type: "offer", sdp: "remote-sdp" });
      expect(fakePc.addCandidateLog).toEqual([early]);

      // A renegotiation: another setRemoteDescription. The previously-drained
      // candidate must NOT be re-applied.
      await adapter.setRemoteDescription({ type: "offer", sdp: "renegotiation-sdp" });
      expect(fakePc.addCandidateLog).toEqual([early]);
    } finally {
      restoreRtc();
    }
  });

  it("returns a promise that resolves immediately when buffered (so callers can await without timing it)", async () => {
    const fakePc = installFakeRtc();
    try {
      const adapter = new WebRtcAdapter();
      expect(fakePc.remoteDescription).toBeNull();

      // The adapter's contract is that addIceCandidate always returns a
      // promise; when buffered it resolves immediately rather than deferring
      // until the drain completes. This lets the bridge's `void ... .catch`
      // surface stay correct.
      const result = adapter.addIceCandidate({ candidate: "x", sdpMid: "0" });
      await expect(result).resolves.toBeUndefined();
      expect(fakePc.addCandidateLog).toEqual([]);
    } finally {
      restoreRtc();
    }
  });
});
