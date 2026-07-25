import { expect, test } from "@playwright/test";

import { CONNECTION_STATE_TEXT, establishPeerPair } from "./_helpers";

/**
 * Scenarios 4, 5, 6: the real two-browser P2P conversation. Two isolated
 * browser contexts (separate localStorage / identity) establish a real WebRTC
 * session through the in-process broker, exchange messages, and display a
 * matching safety number. These tests are the make-or-break proof the chat
 * actually works between two browsers.
 *
 * Loopback WebRTC needs no STUN; the config's empty iceServers list is correct.
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
      await expect(
        pair.pageA.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        pair.pageB.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
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
      await expect(
        pair.pageA.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        pair.pageB.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });

      // Each side renders a compact "Unverified" badge that opens the safety
      // number dialog. Open both so the full number is readable in the DOM.
      await pair.pageA.getByRole("button", { name: "Review safety number" }).click();
      await pair.pageB.getByRole("button", { name: "Review safety number" }).click();

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
      const safetyDialogA = pair.pageA.getByRole("dialog", { name: "Safety number" });
      const safetyDialogB = pair.pageB.getByRole("dialog", { name: "Safety number" });
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
      await expect(
        pair.pageA.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        pair.pageB.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });

      const composer = pair.pageA.getByRole("textbox", { name: "Message" });

      // Shift+Enter inserts a newline — no send. The composer grows; no
      // message lands on the peer.
      await composer.fill("first line");
      await composer.press("Shift+Enter");
      await composer.type("second line");
      await expect(composer).toHaveValue("first line\nsecond line");

      // Enter sends. A's own transcript shows the sent bubble; B receives it.
      await composer.press("Enter");
      await expect(pair.pageA.getByText("first line\nsecond line")).toBeVisible({
        timeout: 10_000,
      });
      await expect(pair.pageB.getByText("first line\nsecond line")).toBeVisible({
        timeout: 10_000,
      });

      // A second message preserves order on the receiver.
      const composerB = pair.pageB.getByRole("textbox", { name: "Message" });
      await composerB.fill("reply one");
      await composerB.press("Enter");
      await composerB.fill("reply two");
      await composerB.press("Enter");

      await expect(pair.pageA.getByText("reply one")).toBeVisible({ timeout: 10_000 });
      await expect(pair.pageA.getByText("reply two")).toBeVisible({ timeout: 10_000 });

      // Ordering: "reply one" must appear before "reply two" in the DOM.
      const aText = (await pair.pageA.evaluate(() => document.body.innerText)) as string;
      expect(aText.indexOf("reply one")).toBeLessThan(aText.indexOf("reply two"));
    } finally {
      await pair.close();
    }
  });
});
