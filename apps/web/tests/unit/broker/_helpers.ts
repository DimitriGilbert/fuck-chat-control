export class MockBrokerSocket {
  public sent: string[] = [];
  public closed = false;
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  // Default to OPEN so existing tests keep working; the zombie-sweep tests
  // override this to CLOSING (2) / CLOSED (3) to simulate a stuck socket.
  public readyState = 1;

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
