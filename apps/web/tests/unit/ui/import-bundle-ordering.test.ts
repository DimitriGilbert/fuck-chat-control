// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import type { ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { ImportMode } from "@fuck-eu-chat-control/chat-runtime/store";

import { ImportBundleDialog } from "@/features/chat/ui/import-bundle-dialog";

/**
 * R10F4 (Phase 9.3): file-read ordering in the import dialog. `setFilename`
 * applies synchronously while `file.text()` resolves unordered — before the
 * request token, the LAST-SETTLING read won `bundle` while `filename` already
 * showed the last pick, and a stale `.catch` could clear a newer valid
 * bundle. The token must let ONLY the latest pick's continuation touch
 * `filename`/`bundle` state.
 *
 * Rendered under jsdom with useChat/sonner swapped for per-test harnesses,
 * mirroring tests/unit/ui/export-bundle-revoke.test.ts. The picked files are
 * `{name, text}` doubles whose `text()` promises the test settles by hand —
 * jsdom inputs can't hold a real FileList, so `files` is planted via
 * Object.defineProperty per pick (the standard jsdom file-input seam).
 */

const ctx = vi.hoisted(() => ({ controller: null as null | unknown }));

vi.mock("@/features/chat/runtime/chat-provider", () => ({
  useChat: () => ({ controller: ctx.controller }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

function deferred(): {
  readonly promise: Promise<string>;
  readonly resolve: (v: string) => void;
  readonly reject: (e: Error) => void;
} {
  let resolve: (v: string) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal File double: handleFile reads `name` and `text()` only. */
function fakeFile(name: string, text: Promise<string>): File {
  return { name, text: () => text } as unknown as File;
}

function pickFile(file: File): void {
  const input = screen.getByLabelText("Bundle file") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

function pickNothing(): void {
  const input = screen.getByLabelText("Bundle file") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [], configurable: true });
  fireEvent.change(input);
}

describe("ImportBundleDialog file-read ordering (R10F4)", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
    ctx.controller = { importBundle: vi.fn().mockResolvedValue({}) } as unknown as ChatController;
  });

  afterEach(cleanup);

  it("a stale late-settling read cannot overwrite the latest pick's bundle", async () => {
    const importBundle = (ctx.controller as { importBundle: ReturnType<typeof vi.fn> })
      .importBundle;
    const a = deferred();
    const b = deferred();
    render(
      React.createElement(ImportBundleDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onImported: vi.fn(),
      }),
    );

    pickFile(fakeFile("a.json", a.promise));
    pickFile(fakeFile("b.json", b.promise));
    // The filename tracks the LATEST pick immediately.
    expect(screen.getByText("Loaded: b.json")).toBeTruthy();

    // B (the latest pick) settles first...
    await act(async () => {
      b.resolve("bundle-B");
      await b.promise;
    });
    // ...then A settles LATE. Stale: it must not clobber B's bundle.
    await act(async () => {
      a.resolve("bundle-A");
      await a.promise;
    });
    expect(screen.getByText("Loaded: b.json")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "pw" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import" }));
    });

    // The imported bundle is the LATEST pick's content — without the token
    // the last-settling (stale) read would have won and imported bundle-A.
    expect(importBundle).toHaveBeenCalledWith("pw", "bundle-B", ImportMode.Merge);
  });

  it("a stale .catch cannot clear the newer pick's bundle or toast an error", async () => {
    const importBundle = (ctx.controller as { importBundle: ReturnType<typeof vi.fn> })
      .importBundle;
    const a = deferred();
    const b = deferred();
    render(
      React.createElement(ImportBundleDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onImported: vi.fn(),
      }),
    );

    pickFile(fakeFile("a.json", a.promise));
    pickFile(fakeFile("b.json", b.promise));

    await act(async () => {
      b.resolve("bundle-B");
      await b.promise;
    });
    // A's read now FAILS late — the stale catch must not clear B's bundle
    // nor surface "Could not read file" for a pick that is no longer live.
    await act(async () => {
      a.reject(new Error("read failed"));
      await a.promise.catch(() => {});
    });
    expect(toasts.error).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "pw" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import" }));
    });
    expect(importBundle).toHaveBeenCalledWith("pw", "bundle-B", ImportMode.Merge);
  });

  it("clearing the picker resets bundle state", async () => {
    const a = deferred();
    render(
      React.createElement(ImportBundleDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onImported: vi.fn(),
      }),
    );

    pickFile(fakeFile("a.json", a.promise));
    await act(async () => {
      a.resolve("bundle-A");
      await a.promise;
    });
    expect(screen.getByText("Loaded: a.json")).toBeTruthy();

    pickNothing();
    expect(screen.queryByText(/Loaded:/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "pw" } });
    // No bundle → Import stays disabled.
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
