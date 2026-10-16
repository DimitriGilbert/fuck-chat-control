export class MockBrokerSocket {
  public sent: string[] = [];
  public closed = false;
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  // Default to OPEN so existing tests keep working; the zombie-sweep tests
  // override this to CLOSING (2) / CLOSED (3) to simulate a stuck socket.
  public readyState = 1;
  // R4/F1: bytes queued but unflushed. send() does not grow it (the mock
  // buffers nothing); tests override it to simulate a stalled TCP receiver.
  public bufferedAmount = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }
}
