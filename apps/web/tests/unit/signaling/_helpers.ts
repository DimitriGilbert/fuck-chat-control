import type { SignalingSocket } from "@/features/chat/signaling/signaling-client";

export class MockSignalingSocket implements SignalingSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  private opener: (() => void) | null = null;
  private messageHandler: ((event: { readonly data: string }) => void) | null = null;
  private closer: (() => void) | null = null;
  private errorer: (() => void) | null = null;
  public closed = false;
  public closeCode: number | undefined;

  public set onopen(value: (() => void) | null) {
    this.opener = value;
  }
  public set onmessage(value: ((event: { readonly data: string }) => void) | null) {
    this.messageHandler = value;
  }
  public set onclose(value: (() => void) | null) {
    this.closer = value;
  }
  public set onerror(value: (() => void) | null) {
    this.errorer = value;
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.closer?.();
  }

  public serverOpen(): void {
    this.readyState = 1;
    this.opener?.();
  }

  public deliver(data: string): void {
    this.messageHandler?.({ data });
  }

  public serverClose(): void {
    this.readyState = 3;
    this.closer?.();
  }

  public emitError(): void {
    this.errorer?.();
  }
}

export interface Parsed {
  readonly t: string;
  readonly roomId?: string;
  readonly sdp?: unknown;
  readonly candidate?: unknown;
}

export function parse(raw: string): Parsed {
  return JSON.parse(raw) as Parsed;
}
