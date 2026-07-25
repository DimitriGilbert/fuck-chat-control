import {
  deriveSessionKeys,
  encryptFrame,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
} from "@/features/chat/crypto";
import type { SessionKeys, AESKey } from "@/features/chat/crypto";
import {
  MAX_BUFFERED_DATA_BYTES,
  PROTOCOL_VERSION,
  SESSION_ID_BYTES,
} from "@/features/chat/protocol/limits";
import { encodeSessionId } from "@/features/chat/protocol/codec";
import type { FrameAad, FrameType, PublicKey, SessionId } from "@/features/chat/protocol/types";

import { buildCanonicalTranscript, conversationId } from "../crypto/_helpers";
import {
  FrameReceiver,
  encodeWireFrame,
  type FrameReceiverConfig,
  type FrameReceiverHandlers,
  type FrameTransport,
} from "@/features/chat/framing";
import { FrameSender } from "@/features/chat/framing";

interface PeerMaterial {
  readonly identityPublicKey: PublicKey;
  readonly session: SessionId;
}

async function makePeer(seed: number): Promise<PeerMaterial> {
  const identity = await generateIdentityKeyPair();
  return { identityPublicKey: identity.publicKey, session: sessionId(seed) };
}

export interface LinkedPair {
  readonly sender: FrameSender;
  readonly receiver: FrameReceiver;
  readonly transport: MockTransport;
  readonly recvKeys: SessionKeys;
  readonly peerSessionId: SessionId;
}

export async function makePair(handlers: FrameReceiverHandlers): Promise<LinkedPair> {
  const conv = conversationId(401);
  const a = await makePeer(1);
  const b = await makePeer(2);
  const aEcdh = await generateEphemeralKeyPair();
  const bEcdh = await generateEphemeralKeyPair();
  const transcript = buildCanonicalTranscript(
    conv,
    {
      identityPublicKey: a.identityPublicKey,
      ecdhPublicKey: aEcdh.publicKey,
      sessionId: a.session,
    },
    {
      identityPublicKey: b.identityPublicKey,
      ecdhPublicKey: bEcdh.publicKey,
      sessionId: b.session,
    },
  );
  const aKeys = await deriveSessionKeys({
    localEcdhPrivateKey: aEcdh.privateKey,
    peerEcdhPublicKey: bEcdh.publicKey,
    transcript,
    localIdentityPublicKey: a.identityPublicKey,
  });
  const bKeys = await deriveSessionKeys({
    localEcdhPrivateKey: bEcdh.privateKey,
    peerEcdhPublicKey: aEcdh.publicKey,
    transcript,
    localIdentityPublicKey: b.identityPublicKey,
  });

  const transport = new MockTransport();
  const receiverConfig: FrameReceiverConfig = {
    sessionKeys: bKeys,
    peerSessionId: a.session,
    ...handlers,
  };
  const receiver = new FrameReceiver(receiverConfig);
  transport.attachIngest((bytes) => receiver.ingest(bytes));
  const sender = new FrameSender({
    sessionKeys: aKeys,
    localSessionId: a.session,
    peerSessionId: b.session,
    transport,
  });
  return { sender, receiver, transport, recvKeys: bKeys, peerSessionId: a.session };
}

export function sessionId(seed: number): SessionId {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  for (let i = 0; i < SESSION_ID_BYTES; i++) bytes[i] = (seed * 17 + i + 1) & 0xff;
  return encodeSessionId(bytes);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function deterministicData(size: number, seed = 3): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + seed) & 0xff;
  return data;
}

export async function waitFor<T>(fn: () => T, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  let last: T = fn();
  while (!last && Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = fn();
  }
  if (!last) throw new Error("waitFor timed out");
  return last;
}

export async function forgeFrame(
  recvKey: AESKey,
  senderSessionId: SessionId,
  sequence: number,
  frameType: FrameType,
  transferId: number,
  chunkId: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const aad: FrameAad = {
    protocolVersion: PROTOCOL_VERSION,
    senderSessionId,
    senderSequence: sequence,
    frameType,
    transferId,
    chunkId,
  };
  const enc = await encryptFrame(recvKey, aad, plaintext);
  const header = { ...aad, ciphertextLength: enc.ciphertext.length };
  return encodeWireFrame(header, enc.nonce, enc.ciphertext);
}

export class MockTransport implements FrameTransport {
  readonly sent: Uint8Array[] = [];
  readonly errors: Error[] = [];
  private pendingAmount = 0;
  private readyFlag = true;
  private drainListener: (() => void) | null = null;
  private ingestFn: ((bytes: Uint8Array) => Promise<void>) | null = null;
  private ingestChain: Promise<void> = Promise.resolve();

  attachIngest(ingest: (bytes: Uint8Array) => Promise<void>): void {
    this.ingestFn = ingest;
  }

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
    if (this.ingestFn !== null) {
      const fn = this.ingestFn;
      this.ingestChain = this.ingestChain.then(() =>
        fn(bytes).catch((err: unknown) => {
          if (err instanceof Error) this.errors.push(err);
        }),
      );
    }
  }

  get bufferedAmount(): number {
    return this.pendingAmount;
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  setDrainListener(listener: (() => void) | null): void {
    this.drainListener = listener;
  }

  setBufferedAmount(amount: number): void {
    this.pendingAmount = amount;
    this.readyFlag = amount < MAX_BUFFERED_DATA_BYTES;
  }

  triggerDrain(): void {
    if (this.drainListener !== null) this.drainListener();
  }

  get ingestSettled(): Promise<void> {
    return this.ingestChain;
  }
}
