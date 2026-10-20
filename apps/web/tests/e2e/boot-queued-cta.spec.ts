import { expect, test } from "@playwright/test";

import { invitationLinkInput, startConversationButton } from "./_helpers";

/**
 * Boot-window UX: the OPFS worker (wa-sqlite + inlined wasm) is the longest
 * leg of startup. The primary CTA must communicate that boot is in progress
 * and must accept a click during it — the intent is queued and fires the
 * moment the controller publishes.
 *
 * The worker script request is delayed 4s so the boot window is observable
 * instead of racing a sub-second real startup.
 */

const WORKER_DELAY_MS = 4_000;

test.describe("boot: queued start conversation", () => {
  test("click during boot shows a booting state, then starts once ready", async ({ page }) => {
    await page.route("**/assets/opfs-worker-*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, WORKER_DELAY_MS));
      await route.continue();
    });

    await page.goto("/");

    const cta = startConversationButton(page);
    // While the worker is still booting: the CTA is enabled (clickable) and
    // tells the user what is happening instead of sitting dead.
    await expect(cta).toHaveText(/Setting up secure storage/, { timeout: 10_000 });
    await expect(cta).toBeEnabled();

    // Clicking during boot queues the intent — no dead click.
    await cta.click();

    // Once the delayed worker finishes, the queued start fires: the
    // invitation link input appears without a second click.
    const invitationInput = invitationLinkInput(page);
    await expect(invitationInput).toBeVisible({ timeout: 20_000 });
    expect(await invitationInput.inputValue()).toMatch(/#[0-9a-f]{32}$/);
  });
});
