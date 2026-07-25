export class MockBrokerSocket {
  public sent: string[] = [];
  public closed = false;
  public closeCode: number | undefined;
  public closeReason: string | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}
