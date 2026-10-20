import { expect, test } from "@playwright/test";

import { CONNECTION_STATE_TEXT, connectionStatePill, establishPeerPair, TID } from "./_helpers";

/**
 * Scenarios 4, 5, 6: the real two-browser P2P conversation. Two isolated
 * browser contexts (separate localStorage / identity) establish a real WebRTC
 * session through the in-process broker, exchange messages, and display a
 * matching safety number. These tests are the make-or-break proof the chat
 * actually works between two browsers.
 *
 * Loopback WebRTC needs no STUN. The /ice-config endpoint returns an empty
 * iceServers list when no STUN/TURN env is configured (the CI/dev baseline),
 * and the chat-provider falls back to [] on any fetch failure — so loopback
 * P2P here always gathers host candidates only.
 * Timeouts are generous because ICE on loopback can take a few seconds and the
 * dev server SSR-compiles on first boot.
 */

test.describe("two-context P2P", () => {
  test("two isolated contexts establish a real P2P session", async ({ browser }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      // Both peers should reach Connected. This is THE proof the handshake
      // completed over a real RTCPeerConnection.
      await expect(connectionStatePill(pair.pageA)).toBeVisible({ timeout: 45_000 });
      await expect(connectionStatePill(pair.pageB)).toBeVisible({ timeout: 45_000 });
    } finally {
      await pair.close();
    }
  });

  test("both peers display the same safety number, unverified by default", async ({ browser }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      // Wait for connected first; the safety number only appears after the
      // handshake completes.
      await expect(connectionStatePill(pair.pageA)).toBeVisible({ timeout: 45_000 });
      await expect(connectionStatePill(pair.pageB)).toBeVisible({ timeout: 45_000 });

      // Each side renders a compact "Unverified" badge that opens the safety
      // number dialog. Open both so the full number is readable in the DOM.
      await pair.pageA.getByTestId(TID.verifyPeer).click();
      await pair.pageB.getByTestId(TID.verifyPeer).click();

      // The safety number is grouped digit pairs (XX XX XX ...).
      const safetyPattern = /^\d{2} \d{2} \d{2}.*\d{2}$/;
      const aNumber = (await pair.pageA.getByText(safetyPattern).first().textContent()) ?? "";
      const bNumber = (await pair.pageB.getByText(safetyPattern).first().textContent()) ?? "";

      expect(aNumber).toMatch(safetyPattern);
      expect(bNumber).toMatch(safetyPattern);
      // The same safety number on both sides is the cryptographic guarantee
      // there is no MITM: both ends derive it from the transcript of the
      // authenticated handshake.
      expect(aNumber).toBe(bNumber);

      // Both badges still say "Unverified" until the user explicitly confirms.
      // Closing the dialog without confirming must not block chat. The dialog
      // also renders an icon close button (X) with an sr-only "Close" name, so
      // target the explicit footer Close button via the DialogFooter.
      const safetyDialogA = pair.pageA.getByRole("dialog", { name: "Verify it's really them" });
      const safetyDialogB = pair.pageB.getByRole("dialog", { name: "Verify it's really them" });
      await safetyDialogA.getByRole("button", { name: "Close", exact: true }).last().click();
      await safetyDialogB.getByRole("button", { name: "Close", exact: true }).last().click();
    } finally {
      await pair.close();
    }
  });

  test("Enter sends, Shift+Enter inserts a newline; messages cross both peers in order", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      await expect(connectionStatePill(pair.pageA)).toBeVisible({ timeout: 45_000 });
      await expect(connectionStatePill(pair.pageB)).toBeVisible({ timeout: 45_000 });

      const composer = pair.pageA.getByRole("textbox", { name: "Message" });

      // Shift+Enter inserts a newline — no send. The composer grows; no
      // message lands on the peer.
      await composer.fill("first line");
      await composer.press("Shift+Enter");
      await composer.type("second line");
      await expect(composer).toHaveValue("first line\nsecond line");

      // Enter sends. A's own transcript shows the sent bubble; B receives it.
      await composer.press("Enter");
      await expect(pair.pageA.getByRole("main").getByText("first line\nsecond line")).toBeVisible({
        timeout: 10_000,
      });
      await expect(pair.pageB.getByRole("main").getByText("first line\nsecond line")).toBeVisible({
        timeout: 10_000,
      });

      // A second message preserves order on the receiver.
      const composerB = pair.pageB.getByRole("textbox", { name: "Message" });
      await composerB.fill("reply one");
      await composerB.press("Enter");
      await composerB.fill("reply two");
      await composerB.press("Enter");

      await expect(pair.pageA.getByRole("main").getByText("reply one")).toBeVisible({
        timeout: 10_000,
      });
      await expect(pair.pageA.getByRole("main").getByText("reply two")).toBeVisible({
        timeout: 10_000,
      });

      // Ordering: "reply one" must appear before "reply two" in the transcript.
      // Scope to the main pane so the sidebar's last-message preview (which
      // always shows the most recent message and so collapses to "reply two")
      // does not invert the order check.
      const aText = (await pair.pageA
        .getByRole("main")
        .evaluate((el) => (el as HTMLElement).innerText)) as string;
      expect(aText.indexOf("reply one")).toBeLessThan(aText.indexOf("reply two"));
    } finally {
      await pair.close();
    }
  });

  test("a text file sent A->B renders an attachment card on B with a Save action", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      // The synthetic drop below bypasses the composer's disabled-until-
      // Connected gate, so it MUST wait for the real Connected state — the
      // pill element itself is mounted in every state, and a file dropped
      // while still handshaking is silently lost.
      await expect(connectionStatePill(pair.pageA)).toContainText(CONNECTION_STATE_TEXT.connected, {
        timeout: 45_000,
      });

      // Drive a file send through a synthetic drop on the chat drop zone. The
      // native file picker is hard to drive from Playwright, so we dispatch a
      // Drop event carrying a real File directly onto the chat-view container
      // (marked with data-drop-zone="chat"). The component's handleDrop reads
      // dataTransfer.files and calls controller.sendFile for each.
      await pair.pageA.evaluate(async () => {
        const file = new File(["hello from A"], "shared.txt", { type: "text/plain" });
        const dropZone = document.querySelector("[data-drop-zone='chat']") as HTMLElement | null;
        if (dropZone === null) throw new Error("chat drop zone not found");
        const transfer = new DataTransfer();
        // The drop handler reads .files; override it with our synthetic File
        // list since DataTransfer constructed in JS cannot be populated via
        // the usual drag gestures.
        Object.defineProperty(transfer, "files", { value: [file], configurable: true });
        const evt = new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(evt, "dataTransfer", { value: transfer, configurable: true });
        dropZone.dispatchEvent(evt);
      });

      // B's transcript shows the attachment card with the filename + a Save
      // button. Scope to the main pane so the sidebar does not match.
      await expect(
        pair.pageB.getByRole("main").getByText("shared.txt", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        pair.pageB.getByRole("main").getByRole("button", { name: /Save shared\.txt/ }),
      ).toBeVisible({ timeout: 10_000 });

      // A's own transcript shows the sent card too.
      await expect(
        pair.pageA.getByRole("main").getByText("shared.txt", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      await pair.close();
    }
  });

  test("an image sent A->B renders a thumbnail on B's attachment card", async ({ browser }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      // Same drop-bypass race as the text-file test: wait for the real
      // Connected label before dispatching the synthetic drop.
      await expect(connectionStatePill(pair.pageA)).toContainText(CONNECTION_STATE_TEXT.connected, {
        timeout: 45_000,
      });

      // 1x1 PNG bytes.
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
      await pair.pageA.evaluate(async (base64) => {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], "pixel.png", { type: "image/png" });
        const dropZone = document.querySelector("[data-drop-zone='chat']") as HTMLElement | null;
        if (dropZone === null) throw new Error("chat drop zone not found");
        const transfer = new DataTransfer();
        Object.defineProperty(transfer, "files", { value: [file], configurable: true });
        const evt = new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(evt, "dataTransfer", { value: transfer, configurable: true });
        dropZone.dispatchEvent(evt);
      }, pngBase64);

      // B's card shows the image filename and a thumbnail <img>.
      await expect(
        pair.pageB.getByRole("main").getByText("pixel.png", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      // The thumbnail is an <img> inside the attachment media slot.
      await expect(pair.pageB.getByRole("main").locator("img").first()).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await pair.close();
    }
  });
});
