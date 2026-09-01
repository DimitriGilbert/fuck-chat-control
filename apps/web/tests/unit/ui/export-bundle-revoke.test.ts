// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import type { ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";

import { ExportBundleDialog } from "@/features/chat/ui/export-bundle-dialog";

/**
 * R7/F6: `downloadBundle` used to call `URL.revokeObjectURL` synchronously
 * after `anchor.click()`, which can abort the download in Safari and older
 * Firefox. The revoke is now deferred to the next macrotask, mirroring the
 * file-transfer-card.tsx SaveAction precedent. This test pins both halves:
 * nothing is revoked in the task that performed the click, and the revoke
 * lands on the NEXT macrotask, after the anchor was clicked.
 *
 * Fake timers freeze the macrotask queue, which is what makes the first half
 * assertable: React's async act() already ends with a real macrotask flush,
 * so under real timers a 0 ms revoke would fire before the assertion. With
 * the queue frozen the revoke can only run when the test advances it.
 *
 * Rendered under jsdom with useChat/sonner swapped for per-test harnesses,
 * mirroring tests/unit/ui/destructive-confirm.test.ts. jsdom ships no
 * object-URL implementation, so both sides of the URL seam are stubbed with
 * spies; the anchor's click is stubbed so jsdom does not attempt navigation.
 */

/** Harness shared with the hoisted useChat mock below. */
const ctx = vi.hoisted(() => ({ controller: null as null | unknown }));

vi.mock("@/features/chat/runtime/chat-provider", () => ({
  useChat: () => ({ controller: ctx.controller }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const BLOB_URL = "blob:export-bundle-fixture";

/** Object-URL seam: jsdom has no implementation, spies double as the stub. */
const urls = {
  create: vi.fn((): string => BLOB_URL),
  revoke: vi.fn(),
};

/** Anchor clicks are stubbed so jsdom does not try to follow the href. */
const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

/**
 * Controller double covering exactly the method the dialog touches. Built
 * structurally then cast through `unknown` (no `any`), per the project's
 * test-fake convention (see auth-mode-surface.test.ts).
 */
function makeController(): {
  readonly controller: ChatController;
  readonly exportBundle: ReturnType<typeof vi.fn>;
} {
  const exportBundle = vi.fn().mockResolvedValue('{"v":1}');
  const controller = { exportBundle } as unknown as ChatController;
  return { controller, exportBundle };
}

/** Renders the dialog, enters a passphrase, clicks Export, drains the chain. */
async function runExport(): Promise<ReturnType<typeof vi.fn>> {
  const { controller, exportBundle } = makeController();
  ctx.controller = controller;
  render(React.createElement(ExportBundleDialog, { open: true, onOpenChange: vi.fn() }));
  fireEvent.change(screen.getByLabelText("Passphrase"), {
    target: { value: "correct horse battery staple" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
  });
  return exportBundle;
}

describe("ExportBundleDialog blob-URL revoke (R7/F6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toasts.success.mockClear();
    toasts.error.mockClear();
    urls.create.mockClear();
    urls.revoke.mockClear();
    anchorClick.mockClear();
    Object.defineProperty(URL, "createObjectURL", {
      value: urls.create,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: urls.revoke,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("defers the revoke to the macrotask after the download click", async () => {
    const exportBundle = await runExport();

    // The export promise has settled and the anchor was clicked, so every
    // microtask of the export chain has run — the revoke must NOT have
    // ridden along: a synchronous revoke is what aborts the download in
    // Safari and older Firefox.
    expect(exportBundle).toHaveBeenCalledTimes(1);
    expect(exportBundle).toHaveBeenCalledWith("correct horse battery staple");
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(urls.revoke).not.toHaveBeenCalled();

    // ...but the URL IS revoked on the next macrotask, never before the
    // anchor click that starts the download.
    vi.advanceTimersByTime(0);

    expect(urls.revoke).toHaveBeenCalledTimes(1);
    expect(urls.revoke).toHaveBeenCalledWith(BLOB_URL);
    expect(anchorClick.mock.invocationCallOrder[0]).toBeLessThan(
      urls.revoke.mock.invocationCallOrder[0],
    );
  });
});
