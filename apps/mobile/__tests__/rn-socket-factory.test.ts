/**
 * Unit tests for the rn-socket-factory adapter. Verifies it maps the RN
 * WebSocket event shapes (onopen/onmessage/onclose/onerror) to the
 * SignalingSocket surface chat-runtime expects.
 */
import type { SignalingSocket } from '@fuck-eu-chat-control/chat-runtime/signaling/signaling-client';

import { rnSocketFactory } from '../src/chat/rn-socket-factory';

interface FakeRnWebSocket {
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  __emitOpen(): void;
  __emitMessage(data: unknown): void;
  __emitClose(): void;
  __emitError(): void;
}

function makeFakeRnWebSocket(): FakeRnWebSocket {
  const ws: FakeRnWebSocket = {
    readyState: 0,
    send: jest.fn(),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    __emitOpen: () => {
      ws.readyState = 1;
      ws.onopen?.({});
    },
    __emitMessage: (data: unknown) => {
      ws.onmessage?.({ data });
    },
    __emitClose: () => {
      ws.readyState = 3;
      ws.onclose?.({});
    },
    __emitError: () => {
      ws.onerror?.({});
    },
  };
  return ws;
}

describe('rnSocketFactory', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('adapts RN WebSocket to the SignalingSocket surface', () => {
    const fake = makeFakeRnWebSocket();
    globalThis.WebSocket = jest.fn(() => fake) as unknown as typeof WebSocket;
    const socket: SignalingSocket = rnSocketFactory('wss://broker.example/ws');
    expect(typeof socket.send).toBe('function');
    expect(typeof socket.close).toBe('function');
    expect(socket.readyState).toBe(0);
  });

  it('routes onopen to a nullary callback', () => {
    const fake = makeFakeRnWebSocket();
    globalThis.WebSocket = jest.fn(() => fake) as unknown as typeof WebSocket;
    const socket = rnSocketFactory('wss://broker.example/ws');
    const onOpen = jest.fn();
    socket.onopen = onOpen;
    fake.__emitOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]).toEqual([]);
  });

  it('routes onmessage to a { data } payload and coerces non-strings', () => {
    const fake = makeFakeRnWebSocket();
    globalThis.WebSocket = jest.fn(() => fake) as unknown as typeof WebSocket;
    const socket = rnSocketFactory('wss://broker.example/ws');
    const onMessage = jest.fn();
    socket.onmessage = onMessage;
    fake.__emitMessage('hello');
    expect(onMessage).toHaveBeenCalledWith({ data: 'hello' });
    // Non-string payload (defensive) is coerced via String().
    fake.__emitMessage(42);
    expect(onMessage).toHaveBeenLastCalledWith({ data: '42' });
  });

  it('routes onclose and onerror to nullary callbacks', () => {
    const fake = makeFakeRnWebSocket();
    globalThis.WebSocket = jest.fn(() => fake) as unknown as typeof WebSocket;
    const socket = rnSocketFactory('wss://broker.example/ws');
    const onClose = jest.fn();
    const onError = jest.fn();
    socket.onclose = onClose;
    socket.onerror = onError;
    fake.__emitClose();
    fake.__emitError();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('forwards send() and close() to the underlying socket', () => {
    const fake = makeFakeRnWebSocket();
    globalThis.WebSocket = jest.fn(() => fake) as unknown as typeof WebSocket;
    const socket = rnSocketFactory('wss://broker.example/ws');
    socket.send('frame');
    expect(fake.send).toHaveBeenCalledWith('frame');
    socket.close(1000, 'bye');
    expect(fake.close).toHaveBeenCalledWith(1000, 'bye');
  });
});
