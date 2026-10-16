import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";

/**
 * Phase 4 turnover fix: WebRtcAdapter.createDataChannel must refuse ONLY
 * while the existing channel is LIVE ("connecting"/"open").
 * RTCDataChannel.close() flips readyState to "closing" synchronously and
 * "closed" arrives via a queued task, so the same-tick turnover path —
 * peer-join → releaseNegotiation → discardChannel → initiateOffer →
 * createDataChannel — observes "closing" and must still re-create. The
 * previous `!== "closed"` guard threw on "closing" and silently killed the
 * re-offer (initiateOffer's catch then tore the fresh attempt down).
 *
 * The RTCPeerConnection global is stubbed with a spy whose createDataChannel
 * hands out readyState-controllable channel doubles.
 */

class SpyDataChannel {
  public binaryType: BinaryType = "blob";
  public bufferedAmountLowThreshold = 0;
  public bufferedAmount = 0;
  public readyState: RTCDataChannelState = "connecting";

  public addEventListener(): void {
    // no-op: the guard under test never dispatches events
  }

  public removeEventListener(): void {
    // no-op
  }

  public close(): void {
    // Mirror the DOM contract the fix relies on: close() flips readyState to
    // "closing" synchronously; "closed" follows on a later task.
    if (this.readyState === "closing" || this.readyState === "closed") return;
    this.readyState = "closing";
  }
}

class SpyPeerConnection {
  public readonly createdChannels: SpyDataChannel[] = [];
  public connectionState: RTCPeerConnectionState = "new";
  public remoteDescription: RTCSessionDescription | null = null;

  public addEventListener(): void {
    // no-op
  }

  public removeEventListener(): void {
    // no-op
  }

  public createDataChannel(): SpyDataChannel {
    const channel = new SpyDataChannel();
    this.createdChannels.push(channel);
    return channel;
  }

  public close(): void {
    // no-op
  }
}

let originalPeerConnection: unknown;

beforeEach(() => {
  originalPeerConnection = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
});

afterEach(() => {
  const g = globalThis as { RTCPeerConnection?: unknown };
  if (originalPeerConnection === undefined) {
    delete g.RTCPeerConnection;
  } else {
    g.RTCPeerConnection = originalPeerConnection;
  }
});

function installSpyPeerConnection(pc: SpyPeerConnection): void {
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection =
    function (): SpyPeerConnection {
      return pc;
    };
}

describe("WebRtcAdapter.createDataChannel single-channel guard", () => {
  it("throws while the existing channel is live (connecting or open)", () => {
    const pc = new SpyPeerConnection();
    installSpyPeerConnection(pc);
    const adapter = new WebRtcAdapter();

    adapter.createDataChannel();
    const channel = pc.createdChannels[0];
    expect(channel).toBeDefined();

    // Fresh channel starts "connecting" — live.
    expect(() => adapter.createDataChannel()).toThrow("already been created");
    // "open" is equally live.
    channel!.readyState = "open";
    expect(() => adapter.createDataChannel()).toThrow("already been created");
    expect(pc.createdChannels).toHaveLength(1);

    adapter.close();
  });

  it("permits re-creation in the same tick the old channel was closed (turnover)", () => {
    const pc = new SpyPeerConnection();
    installSpyPeerConnection(pc);
    const adapter = new WebRtcAdapter();

    const transport = adapter.createDataChannel();
    // The bridge's discardChannel path runs transport.close(), which flips
    // the underlying channel to "closing" synchronously — the exact state
    // the turnover re-offer observes when it calls createDataChannel in the
    // same tick. Pre-fix this threw "already been created".
    transport.close();
    expect(pc.createdChannels[0]?.readyState).toBe("closing");

    expect(() => adapter.createDataChannel()).not.toThrow();
    expect(pc.createdChannels).toHaveLength(2);

    adapter.close();
  });

  it("permits re-creation once the existing channel is closed", () => {
    const pc = new SpyPeerConnection();
    installSpyPeerConnection(pc);
    const adapter = new WebRtcAdapter();

    adapter.createDataChannel();
    pc.createdChannels[0]!.readyState = "closed";

    expect(() => adapter.createDataChannel()).not.toThrow();
    expect(pc.createdChannels).toHaveLength(2);

    adapter.close();
  });
});
