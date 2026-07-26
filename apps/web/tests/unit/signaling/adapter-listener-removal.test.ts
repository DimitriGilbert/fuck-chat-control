import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DataChannelTransport,
  WebRtcAdapter,
} from "@/features/chat/signaling/webrtc-adapter";

/**
 * R6/F5: WebRtcAdapter.close() and DataChannelTransport.close() must call
 * `removeEventListener` for every listener added in the constructor. The
 * adapter/transport rely on the underlying EventTarget releasing its
 * closures so the RTCPeerConnection / RTCDataChannel can be GC'd promptly.
 *
 * We stub both globals with EventTarget-shaped spies that record every
 * add/remove pair, then assert close() removes exactly the listeners added
 * at construction.
 */

type SpyListener = (event: unknown) => void;

interface ListenerEntry {
  readonly type: string;
  readonly fn: SpyListener;
}

class SpyEventTarget {
  public readonly added: ListenerEntry[] = [];
  public readonly removed: ListenerEntry[] = [];
  public closed = false;

  public addEventListener(type: string, fn: SpyListener): void {
    this.added.push({ type, fn });
  }

  public removeEventListener(type: string, fn: SpyListener): void {
    this.removed.push({ type, fn });
  }

  public close(): void {
    this.closed = true;
  }
}

/**
 * Minimal RTCDataChannel-shaped spy. The transport also reads/writes
 * `binaryType`, `bufferedAmountLowThreshold`, and `bufferedAmount`, and reads
 * `readyState`.
 */
class SpyDataChannel extends SpyEventTarget {
  public binaryType: BinaryType = "blob";
  public bufferedAmountLowThreshold = 0;
  public bufferedAmount = 0;
  public readyState: RTCDataChannelState = "open";
}

/**
 * Minimal RTCPeerConnection-shaped spy. The adapter reads `connectionState`
 * and `remoteDescription`, and calls `createDataChannel` only in paths we do
 * not drive here.
 */
class SpyPeerConnection extends SpyEventTarget {
  public connectionState: RTCPeerConnectionState = "new";
  public remoteDescription: RTCSessionDescription | null = null;
}

let originalDataChannel: unknown;
let originalPeerConnection: unknown;

function installSpyDataChannel(channel: SpyDataChannel): void {
  originalDataChannel = (globalThis as { RTCDataChannel?: unknown }).RTCDataChannel;
  (globalThis as { RTCDataChannel: unknown }).RTCDataChannel = function (): SpyDataChannel {
    return channel;
  };
}

function installSpyPeerConnection(pc: SpyPeerConnection): void {
  originalPeerConnection = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function (): SpyPeerConnection {
    return pc;
  };
}

function restoreGlobals(): void {
  const g = globalThis as {
    RTCDataChannel?: unknown;
    RTCPeerConnection?: unknown;
  };
  if (originalDataChannel === undefined) {
    delete g.RTCDataChannel;
  } else {
    g.RTCDataChannel = originalDataChannel;
  }
  if (originalPeerConnection === undefined) {
    delete g.RTCPeerConnection;
  } else {
    g.RTCPeerConnection = originalPeerConnection;
  }
}

afterEach(() => {
  restoreGlobals();
});

describe("DataChannelTransport.close() removes constructor-added listeners (R6/F5)", () => {
  let spy: SpyDataChannel;

  beforeEach(() => {
    spy = new SpyDataChannel();
    installSpyDataChannel(spy);
  });

  it("removes bufferedamountlow, message, and open listeners", () => {
    const transport = new DataChannelTransport({ channel: spy as unknown as RTCDataChannel });
    // Sanity: three listeners were registered at construction.
    const typesAdded = spy.added.map((e) => e.type);
    expect(typesAdded).toContain("bufferedamountlow");
    expect(typesAdded).toContain("message");
    expect(typesAdded).toContain("open");

    transport.close();

    // Each construction-time listener was removed with the SAME fn reference.
    const typesRemoved = spy.removed.map((e) => e.type);
    expect(typesRemoved).toContain("bufferedamountlow");
    expect(typesRemoved).toContain("message");
    expect(typesRemoved).toContain("open");

    // Same fn references (not just same type strings).
    for (const entry of spy.added) {
      const matchingRemoval = spy.removed.find(
        (r) => r.type === entry.type && r.fn === entry.fn,
      );
      expect(matchingRemoval, `expected removal for ${entry.type}`).toBeDefined();
    }
  });

  it("closes the underlying RTCDataChannel", () => {
    const transport = new DataChannelTransport({ channel: spy as unknown as RTCDataChannel });
    transport.close();
    expect(spy.closed).toBe(true);
  });

  it("after close, a late bufferedamountlow does NOT invoke the drain listener", () => {
    const transport = new DataChannelTransport({ channel: spy as unknown as RTCDataChannel });
    let drainCalls = 0;
    transport.setDrainListener(() => {
      drainCalls++;
    });

    transport.close();

    // Simulate a late event by dispatching to the still-recorded add list.
    const entry = spy.added.find((e) => e.type === "bufferedamountlow");
    if (entry === undefined) throw new Error("bufferedamountlow listener not registered");
    // The handler was removed in close(); invoking the captured fn directly
    // mirrors what a late event would do, and must observe a null drainListener.
    entry.fn(new Event("bufferedamountlow"));
    expect(drainCalls).toBe(0);
  });
});

describe("WebRtcAdapter.close() removes constructor-added listeners (R6/F5)", () => {
  let spy: SpyPeerConnection;

  beforeEach(() => {
    spy = new SpyPeerConnection();
    installSpyPeerConnection(spy);
  });

  it("removes icecandidate, connectionstatechange, and datachannel listeners", () => {
    const adapter = new WebRtcAdapter();
    const typesAdded = spy.added.map((e) => e.type);
    expect(typesAdded).toContain("icecandidate");
    expect(typesAdded).toContain("connectionstatechange");
    expect(typesAdded).toContain("datachannel");

    adapter.close();

    const typesRemoved = spy.removed.map((e) => e.type);
    expect(typesRemoved).toContain("icecandidate");
    expect(typesRemoved).toContain("connectionstatechange");
    expect(typesRemoved).toContain("datachannel");

    // Same fn references.
    for (const entry of spy.added) {
      const matchingRemoval = spy.removed.find(
        (r) => r.type === entry.type && r.fn === entry.fn,
      );
      expect(matchingRemoval, `expected removal for ${entry.type}`).toBeDefined();
    }
  });

  it("closes the underlying RTCPeerConnection", () => {
    const adapter = new WebRtcAdapter();
    adapter.close();
    expect(spy.closed).toBe(true);
  });

  it("close() removes listeners and closes the peer connection; a second close() does not throw", () => {
    const adapter = new WebRtcAdapter();
    adapter.close();
    expect(spy.closed).toBe(true);
    // The adapter's caller (WebRtcBridge) guards double-close via its own
    // `closed` flag. The adapter itself just runs its teardown; a direct
    // second call must not throw (removeEventListener + close are both safe
    // to re-issue per the WebIDL spec).
    expect(() => adapter.close()).not.toThrow();
  });

  it("after close, a late connectionstatechange does NOT invoke the handler", () => {
    let stateCalls = 0;
    const adapter = new WebRtcAdapter({
      onConnectionStateChange: (): void => {
        stateCalls++;
      },
    });

    adapter.close();

    const entry = spy.added.find((e) => e.type === "connectionstatechange");
    if (entry === undefined) throw new Error("connectionstatechange listener not registered");
    entry.fn(new Event("connectionstatechange"));
    expect(stateCalls).toBe(0);
  });
});
