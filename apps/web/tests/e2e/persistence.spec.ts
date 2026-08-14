import { expect, test } from "@playwright/test";

import { CONNECTION_STATE_TEXT, establishPeerPair } from "./_helpers";

/**
 * Persistence e2e: proves the OPFS-backed SQLite store (TanStack DB +
 * wa-sqlite) survives a full page reload. This is the proof the old
 * `BrowserDbConversationRepository` stub is gone — history that was in-memory
 * (and lost on reload) now round-trips through OPFS.
 *
 * The unit suite covers the repo's logic against an in-memory collection;
 * this spec is the only place the real OPFS/Worker path runs end-to-end.
 */

test.describe("persistence across reload", () => {
  test("an exchanged message and its conversation survive a page reload", async ({ browser }) => {
    test.setTimeout(120_000);
    const pair = await establishPeerPair(browser);

    try {
      // Reach Connected so the channel is real, then send a message whose
      // text we will look for after reloading.
      await expect(
        pair.pageA.getByRole("main").getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });

      const marker = `persistence-marker-${Date.now()}`;
      const composer = pair.pageA.getByRole("textbox", { name: "Message" });
      await composer.fill(marker);
      await composer.press("Enter");
      // Wait for B to receive it so we know the round-trip actually happened.
      await expect(pair.pageB.getByRole("main").getByText(marker)).toBeVisible({
        timeout: 15_000,
      });

      // Full reload: tears down the in-memory controller and forces a fresh
      // boot. If persistence works, the conversation and the marker message
      // reappear from OPFS once the controller rebuilds.
      await pair.pageA.reload();

      // The conversation must be listed again (sidebar resumes from the
      // persisted store) and the marker message must be readable.
      await expect(pair.pageA.getByRole("button", { name: /Resume/ })).toBeVisible({
        timeout: 30_000,
      });

      // Resume the persisted conversation and confirm the message survived.
      await pair.pageA
        .getByRole("button", { name: /Resume/ })
        .first()
        .click();
      await expect(pair.pageA.getByRole("main").getByText(marker)).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await pair.close();
    }
  });
});
