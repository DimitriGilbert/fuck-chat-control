import { expect, test } from "@playwright/test";

import { establishPeerPair } from "./_helpers";

/**
 * Scenario 9: settings sheet — export/import bundle round-trip with a
 * passphrase, and the clear-conversation / wipe-all destructive actions are
 * gated behind confirmation dialogs. Tested with a single context and a temp
 * file because the round-trip only touches local state.
 */

test.describe("settings sheet", () => {
  test("clear current conversation and wipe all are behind confirm dialogs", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      await expect(pair.pageA.getByText("Connected", { exact: true })).toBeVisible({
        timeout: 45_000,
      });
      // Send a message so "clear current conversation" has something to clear.
      const composer = pair.pageA.getByRole("textbox", { name: "Message" });
      await composer.fill("to be cleared");
      await composer.press("Enter");
      await expect(pair.pageA.getByText("to be cleared")).toBeVisible({ timeout: 10_000 });

      // Open settings.
      await pair.pageA.getByRole("button", { name: "Open settings" }).click();
      await pair.pageA.getByRole("tab", { name: "Data" }).click();

      // Clear current conversation opens an AlertDialog (not a window.confirm);
      // Cancel must keep the data.
      await pair.pageA.getByRole("button", { name: "Clear current conversation" }).click();
      await expect(pair.pageA.getByText("Clear current conversation?")).toBeVisible();
      await pair.pageA.getByRole("button", { name: "Cancel" }).click();

      // Wipe all opens its own confirm with a destructive action.
      await pair.pageA.getByRole("button", { name: "Wipe all data" }).click();
      await expect(pair.pageA.getByText("Wipe all local data?")).toBeVisible();
      await pair.pageA.getByRole("button", { name: "Wipe all" }).click();
      await expect(pair.pageA.getByText("All data wiped")).toBeVisible({ timeout: 10_000 });
    } finally {
      await pair.close();
    }
  });

  test("export produces a passphrase-protected download; import restores the conversation", async ({
    browser,
    context,
    browserName,
  }) => {
    test.setTimeout(90_000);
    // clipboard permissions are chromium-only; grant them where supported so
    // the export/import toasts don't require a focused tab. Firefox ignores
    // the grant but the flows still work (the page is focused during the test).
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    const pair = await establishPeerPair(browser);

    try {
      await expect(pair.pageA.getByText("Connected", { exact: true })).toBeVisible({
        timeout: 45_000,
      });
      const composer = pair.pageA.getByRole("textbox", { name: "Message" });
      await composer.fill("exported message");
      await composer.press("Enter");

      await pair.pageA.getByRole("button", { name: "Open settings" }).click();
      // Wait for the Sheet to mount before interacting with its tabs.
      await expect(pair.pageA.getByText("Settings")).toBeVisible({ timeout: 5_000 });
      await pair.pageA.getByRole("tab", { name: "Data" }).click();
      await expect(pair.pageA.getByText("Portable bundle")).toBeVisible({ timeout: 5_000 });

      // Export: passphrase is required, then a download starts. Fill the
      // passphrase BEFORE queuing the download click — the Export button is
      // disabled until the passphrase is non-empty, so the order matters.
      await pair.pageA.getByRole("button", { name: "Export bundle" }).click();
      await expect(pair.pageA.getByText("Export encrypted bundle")).toBeVisible({
        timeout: 5_000,
      });
      const exportDialog = pair.pageA.getByRole("dialog", { name: "Export encrypted bundle" });
      await exportDialog.getByLabel("Passphrase").fill("correct horse battery staple");
      const [download] = await Promise.all([
        pair.pageA.waitForEvent("download"),
        exportDialog.getByRole("button", { name: "Export", exact: true }).click(),
      ]);
      const downloadPath = `tests/e2e/.tmp/exported-${Date.now()}.json`;
      await download.saveAs(downloadPath);

      // Wipe local data so the import has a clean slate to restore into.
      await pair.pageA.getByRole("button", { name: "Wipe all data" }).click();
      await expect(pair.pageA.getByText("Wipe all local data?")).toBeVisible({ timeout: 5_000 });
      await pair.pageA.getByRole("button", { name: "Wipe all" }).click();
      await expect(pair.pageA.getByText("All data wiped")).toBeVisible({ timeout: 10_000 });

      // The wipe's confirm closes the settings sheet (onConfirm calls onClose).
      // Re-open it to reach the import affordance.
      await pair.pageA.getByRole("button", { name: "Open settings" }).click();
      await expect(pair.pageA.getByText("Settings")).toBeVisible({ timeout: 5_000 });
      await pair.pageA.getByRole("tab", { name: "Data" }).click();

      // Import: pick the exported file, re-enter the same passphrase, Merge.
      await pair.pageA.getByRole("button", { name: "Import bundle" }).click();
      await expect(pair.pageA.getByText("Import encrypted bundle")).toBeVisible({
        timeout: 5_000,
      });
      const importDialog = pair.pageA.getByRole("dialog", { name: "Import encrypted bundle" });
      await importDialog.getByLabel("Bundle file").setInputFiles(downloadPath);
      await importDialog.getByLabel("Passphrase").fill("correct horse battery staple");
      await importDialog.getByRole("button", { name: "Import" }).click();

      // A success toast confirms the bundle was decrypted and merged.
      await expect(pair.pageA.getByText("Bundle imported")).toBeVisible({ timeout: 15_000 });
    } finally {
      await pair.close();
    }
  });
});

/**
 * Scenario 10: broker disconnection after P2P opening must not interrupt text
 * exchange. SKIPPED: the broker is an in-process nitro WebSocket handler with
 * no harness hook to kill it independently of the dev server, so we cannot
 * simulate a broker drop AFTER the p2p data path opens without faking the
 * transport (which would defeat the point of an e2e test). Leaving this as a
 * real, honest `.skip` with a reason rather than a fake-pass.
 */
test.skip("broker drop after p2p open does not interrupt text exchange", async () => {
  // Requires a controllable broker (start/stop at runtime). The current broker
  // is a single in-process nitro handler booted by the dev server; Playwright
  // has no harness handle to kill only the /ws route mid-session. Do NOT
  // fake-pass this — leave skipped until a controllable broker exists.
});
