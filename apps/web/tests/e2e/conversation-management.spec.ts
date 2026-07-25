import { expect, test } from "@playwright/test";

import { CONNECTION_STATE_TEXT, establishPeerPair } from "./_helpers";

/**
 * Scenario 7 (conversation list + resume/history) and scenario 8
 * (leave / retry / disconnect). The plan's #7 file-transfer parts are
 * DEFERRED in v1 and skipped here.
 */

test.describe("conversation management", () => {
  test("after an exchange the conversation is listed and resumable on the initiator", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      await expect(
        pair.pageA.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });

      // Exchange at least one message so the conversation has persisted
      // content (the list shows conversations created via start/resume).
      const composer = pair.pageA.getByRole("textbox", { name: "Message" });
      await composer.fill("persist this");
      await composer.press("Enter");
      await expect(pair.pageB.getByText("persist this")).toBeVisible({ timeout: 10_000 });

      // Leave returns to the landing (clears the active conversation); the
      // conversation must now be listed there with a Resume affordance.
      await pair.pageA.getByRole("button", { name: "Leave" }).click();
      await expect(
        pair.pageA.getByRole("heading", { name: "fck-chat-control", level: 1 }),
      ).toBeVisible({ timeout: 10_000 });

      await expect(pair.pageA.getByText("Conversations in this browser")).toBeVisible();
      await expect(pair.pageA.getByRole("button", { name: "Resume" })).toBeVisible();
    } finally {
      await pair.close();
    }
  });

  test("a peer dropping surfaces Disconnected + Retry on the other side", async ({ browser }) => {
    test.setTimeout(90_000);
    const pair = await establishPeerPair(browser);

    try {
      await expect(
        pair.pageA.getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });

      // B leaves (returns to its own landing). A observes the drop: its
      // ChatView flips to Disconnected and exposes a Retry affordance.
      await pair.pageB.getByRole("button", { name: "Leave" }).click();
      await expect(
        pair.pageA.getByText(CONNECTION_STATE_TEXT.disconnected, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(pair.pageA.getByRole("button", { name: "Retry" })).toBeVisible();
    } finally {
      await pair.close();
    }
  });
});
