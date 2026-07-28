/**
 * Unit tests for the rn-peer-connection-factory adapter. Verifies the factory
 * builds a PeerConnection that maps react-native-webrtc's event shapes to the
 * 7 neutral chat-runtime interfaces, WITHOUT a real native module.
 *
 * The tests construct a fake RTCPeerConnection + RTCDataChannel with the exact
 * surface react-native-webrtc exposes (onicecandidate/onconnectionstatechange/
 * ondatachannel handler properties + createOffer/Answer/etc.), then assert the
 * adapter maps events faithfully.
 *
 * jest.mock is hoisted above the static import so the real native module
 * (which touches NativeEventEmitter at load) never evaluates.
 */

// A module-scoped handle the test bodies swap per-case. jest.mock factories
// cannot reference out-of-scope variables UNLESS the name is prefixed with
// `mock` — this prefix is the documented escape hatch for lazily-resolved
// mock state.
const mockFakePeerHolder: { current: FakeRTCPeerConnection } = {
  current: makeFakePeerConnection(),
};

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: function () {
    return mockFakePeerHolder.current;
  },
}));

import type {
  DataChannelTransport,
  IceCandidate,
  PeerConnection,
  PeerConnectionFactoryOptions,
} from '@fuck-eu-chat-control/chat-runtime/transport/types';

import { rnPeerConnectionFactory } from '../src/chat/rn-peer-connection-factory';

interface FakeRTCIceCandidateInit {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

interface FakeRTCSessionDescriptionInit {
  readonly type: string;
  readonly sdp: string;
}

interface FakeRTCDataChannel {
  binaryType: string;
  bufferedAmountLowThreshold: number;
  readyState: string;
  bufferedAmount: number;
  send: jest.Mock;
  close: jest.Mock;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onbufferedamountlow: ((event: unknown) => void) | null;
  __emitOpen(): void;
  __emitMessage(data: unknown): void;
  __emitBufferedAmountLow(): void;
}

interface FakeRTCPeerConnection {
  connectionState: string;
  remoteDescription: FakeRTCSessionDescriptionInit | null;
  createOffer: jest.Mock;
  createAnswer: jest.Mock;
  setLocalDescription: jest.Mock;
  setRemoteDescription: jest.Mock;
  addIceCandidate: jest.Mock;
  createDataChannel: jest.Mock;
  onicecandidate: ((event: { readonly candidate: { toJSON(): FakeRTCIceCandidateInit } | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  ondatachannel: ((event: { readonly channel: FakeRTCDataChannel }) => void) | null;
  close: jest.Mock;
  __emitIceCandidate(candidate: FakeRTCIceCandidateInit | null): void;
  __emitConnectionStateChange(): void;
  __emitDataChannel(channel: FakeRTCDataChannel): void;
}

function makeFakeDataChannel(): FakeRTCDataChannel {
  return {
    binaryType: 'text',
    bufferedAmountLowThreshold: 0,
    readyState: 'connecting',
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onbufferedamountlow: null,
    __emitOpen: function (): void {
      this.readyState = 'open';
      this.onopen?.({});
    },
    __emitMessage: function (data: unknown): void {
      this.onmessage?.({ data });
    },
    __emitBufferedAmountLow: function (): void {
      this.onbufferedamountlow?.({});
    },
  };
}

function makeFakePeerConnection(): FakeRTCPeerConnection {
  return {
    connectionState: 'new',
    remoteDescription: null,
    createOffer: jest.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
    createAnswer: jest.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' })),
    setLocalDescription: jest.fn(async () => {}),
    setRemoteDescription: jest.fn(async () => {}),
    addIceCandidate: jest.fn(async () => {}),
    createDataChannel: jest.fn(() => makeFakeDataChannel()),
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    close: jest.fn(),
    __emitIceCandidate: function (candidate: FakeRTCIceCandidateInit | null): void {
      this.onicecandidate?.({
        candidate:
          candidate === null
            ? null
            : { toJSON: () => candidate },
      });
    },
    __emitConnectionStateChange: function (): void {
      this.onconnectionstatechange?.({});
    },
    __emitDataChannel: function (channel: FakeRTCDataChannel): void {
      this.ondatachannel?.({ channel });
    },
  };
}

describe('rnPeerConnectionFactory', () => {
  let fakePc: FakeRTCPeerConnection;

  beforeEach(() => {
    fakePc = makeFakePeerConnection();
    // Swap the module-scoped handle the hoisted jest.mock factory closes over
    // so each test gets a fresh fake peer connection.
    mockFakePeerHolder.current = fakePc;
  });

  it('returns a PeerConnection (neutral interface)', () => {
    const options: PeerConnectionFactoryOptions = {};
    const pc = rnPeerConnectionFactory(options) as PeerConnection;
    expect(typeof pc.createOffer).toBe('function');
    expect(typeof pc.createAnswer).toBe('function');
    expect(typeof pc.setLocalDescription).toBe('function');
    expect(typeof pc.setRemoteDescription).toBe('function');
    expect(typeof pc.addIceCandidate).toBe('function');
    expect(typeof pc.createDataChannel).toBe('function');
    expect(typeof pc.close).toBe('function');
    pc.close();
  });

  it('maps RN icecandidate event to the neutral IceCandidate shape', () => {
    const onIceCandidate = jest.fn();
    const pc = rnPeerConnectionFactory({ onIceCandidate }) as PeerConnection;
    fakePc.__emitIceCandidate({
      candidate: 'candidate:842163049 1 udp 1677729535 ...',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(onIceCandidate).toHaveBeenCalledTimes(1);
    const candidate = onIceCandidate.mock.calls[0]?.[0] as IceCandidate;
    expect(candidate.candidate).toBe('candidate:842163049 1 udp 1677729535 ...');
    expect(candidate.sdpMid).toBe('0');
    expect(candidate.sdpMLineIndex).toBe(0);
    pc.close();
  });

  it('ignores a null icecandidate (end-of-gathering)', () => {
    const onIceCandidate = jest.fn();
    const pc = rnPeerConnectionFactory({ onIceCandidate }) as PeerConnection;
    fakePc.__emitIceCandidate(null);
    expect(onIceCandidate).not.toHaveBeenCalled();
    pc.close();
  });

  it('maps connectionstatechange to the neutral PeerConnectionState', () => {
    const onConnectionStateChange = jest.fn();
    const pc = rnPeerConnectionFactory({ onConnectionStateChange }) as PeerConnection;
    fakePc.connectionState = 'connected';
    fakePc.__emitConnectionStateChange();
    expect(onConnectionStateChange).toHaveBeenCalledWith('connected');
    pc.close();
  });

  it('delivers the responder data channel via onDataChannel', () => {
    const onDataChannel = jest.fn();
    const pc = rnPeerConnectionFactory({ onDataChannel }) as PeerConnection;
    const fakeChannel = makeFakeDataChannel();
    fakePc.__emitDataChannel(fakeChannel);
    expect(onDataChannel).toHaveBeenCalledTimes(1);
    const transport = onDataChannel.mock.calls[0]?.[0] as DataChannelTransport;
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.setOnMessage).toBe('function');
    pc.close();
  });

  it('createOffer/createAnswer return neutral SessionDescription', async () => {
    const pc = rnPeerConnectionFactory({}) as PeerConnection;
    const offer = await pc.createOffer();
    expect(offer.type).toBe('offer');
    expect(offer.sdp).toBe('offer-sdp');
    const answer = await pc.createAnswer();
    expect(answer.type).toBe('answer');
    pc.close();
  });

  it('buffers early ICE candidates and drains them on setRemoteDescription', async () => {
    const pc = rnPeerConnectionFactory({}) as PeerConnection;
    const candidate: IceCandidate = {
      candidate: 'candidate:1',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    // remoteDescription is null → candidate is buffered, not applied.
    await pc.addIceCandidate(candidate);
    expect(fakePc.addIceCandidate).not.toHaveBeenCalled();
    // set a remoteDescription so the drain path runs.
    fakePc.remoteDescription = { type: 'offer', sdp: 'remote' };
    await pc.setRemoteDescription({ type: 'offer', sdp: 'remote' });
    expect(fakePc.addIceCandidate).toHaveBeenCalledWith(candidate);
    pc.close();
  });

  it('routes data-channel messages and open events to the neutral handlers', () => {
    const onDataChannel = jest.fn();
    const pc = rnPeerConnectionFactory({ onDataChannel }) as PeerConnection;
    const fakeChannel = makeFakeDataChannel();
    fakePc.__emitDataChannel(fakeChannel);
    const transport = onDataChannel.mock.calls[0]?.[0] as DataChannelTransport;
    const onMessage = jest.fn();
    transport.setOnMessage(onMessage);
    fakeChannel.__emitMessage(new ArrayBuffer(2));
    expect(onMessage).toHaveBeenCalledTimes(1);
    const received = onMessage.mock.calls[0]?.[0] as Uint8Array;
    expect(received).toBeInstanceOf(Uint8Array);
    expect(received.byteLength).toBe(2);
    pc.close();
  });

  it('sets bufferedAmountLowThreshold to 1 so RN strict-< dispatch can fire', () => {
    // react-native-webrtc's bufferedamountlow dispatch is strict `<`:
    // `if (bufferedAmount < bufferedAmountLowThreshold)`. With threshold 0 the
    // guard is `0 < 0` → never true → the drain listener never runs and
    // FrameSender.waitForDrain blocks forever once buffered crosses
    // MAX_BUFFERED_DATA_BYTES. Threshold 1 makes `0 < 1` fire when buffered
    // drains back to 0. The web adapter keeps 0 because the DOM fires at the
    // boundary — do NOT "fix" the RN value back to 0.
    const onDataChannel = jest.fn();
    const pc = rnPeerConnectionFactory({ onDataChannel }) as PeerConnection;
    const fakeChannel = makeFakeDataChannel();
    fakePc.__emitDataChannel(fakeChannel);
    expect(fakeChannel.bufferedAmountLowThreshold).toBe(1);
    pc.close();
  });
});
