import { describe, expect, it, vi } from "vitest";

import { handlePeerError } from "@/server/broker";

describe("broker error hook — R4/F2", () => {
  it("closes the socket after cleanup so a non-fatal ws error cannot orphan the fd", () => {
    const close = vi.fn();
    const peer = { id: "errored-peer", close };

    handlePeerError(peer);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1011, "websocket error");
  });

  it("is safe when the runtime also delivers a close (cleanup is idempotent, close re-runs)", () => {
    const close = vi.fn();
    const peer = { id: "double-teardown", close };

    // Models an error hook followed by the close hook the explicit close()
    // triggers — teardown must not throw or corrupt state either way.
    handlePeerError(peer);
    handlePeerError(peer);

    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(1011, "websocket error");
  });
});
