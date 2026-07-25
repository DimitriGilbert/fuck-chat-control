import { expect, test } from "@playwright/test";

import { invitationHex } from "./_helpers";

/**
 * Scenarios 1, 2, 3, 11, 12: landing explainer + docs, mobile layout, create
 * conversation + copy link, fragment stays out of server route paths, and
 * the chromium/firefox project matrix covers the browser smoke (the same
 * tests run under both projects declared in playwright.config.ts).
 */

test.describe("landing", () => {
  test("renders the explainer, security model, STUN-only, no-account, and start affordance", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "fck-chat-control", level: 1 })).toBeVisible();

    // Security model + STUN-only + no-account vocabulary is visible somewhere
    // on the landing. These are the load-bearing promises (no identity, no
    // TURN, server never sees content) so they are worth pinning.
    await expect(
      page.getByText("Serverless, end-to-end-encrypted, no-account peer-to-peer chat"),
    ).toBeVisible();
    await expect(page.getByText("Security model")).toBeVisible();
    await expect(page.getByText("STUN-only (no TURN)")).toBeVisible();
    await expect(page.getByText("At-rest encryption")).toBeVisible();

    // Start affordance + conversation list region.
    await expect(page.getByRole("button", { name: /Start a conversation/ })).toBeVisible();
    await expect(page.getByText("Conversations in this browser")).toBeVisible();
  });

  test("layout does not overflow horizontally on a mobile viewport", async ({ page }) => {
    // A real device-class width catches fixed-width elements that force a
    // horizontal scroll on phones. The page must fit within its own viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("start conversation produces a 32-hex invitation link in the URL fragment", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Start a conversation/ }).click();

    const invitationInput = page.getByLabel("Invitation link");
    await expect(invitationInput).toBeVisible({ timeout: 10_000 });
    const invitation = (await invitationInput.inputValue()) as string;

    // The link is http://host#<32 hex> (origin + '#' + hex). The hash carries
    // the conversation id and stays out of any server-visible path or query.
    expect(invitation).toMatch(/^https?:\/\/[^#]+#[0-9a-f]{32}$/);
    expect(invitationHex(invitation)).toHaveLength(32);
  });

  test("the invitation link can be copied via the Copy link button", async ({
    page,
    context,
    browserName,
  }) => {
    // clipboard-read/write permissions are chromium-only; on firefox the
    // navigator.clipboard.writeText call still resolves (the page is focused),
    // we just can't read the result back. Assert the success toast there.
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    await page.goto("/");

    await page.getByRole("button", { name: /Start a conversation/ }).click();
    await page.getByRole("button", { name: /Copy link/ }).click();

    if (browserName === "chromium") {
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toMatch(/#[0-9a-f]{32}$/);
    } else {
      // The toast confirms writeText resolved without throwing.
      await expect(page.getByText("Invitation link copied")).toBeVisible({ timeout: 5_000 });
    }
  });

  test("a #fragment URL loads the index route; the fragment is never sent to the server", async ({
    page,
  }) => {
    const fragment = "0123456789abcdef0123456789abcdef";
    const serverHits: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("localhost:3001")) {
        serverHits.push(new URL(url).pathname + new URL(url).search);
      }
    });

    await page.goto(`http://localhost:3001/#${fragment}`);

    // The browser landed on the index route (not a 404, not a route path
    // containing the hex).
    await expect(page.getByRole("heading", { name: "fck-chat-control", level: 1 })).toBeVisible();

    // The fragment is retained in the URL bar — the join flow reads it from
    // window.location.hash, and it is NOT part of any server request.
    expect(page.url()).toContain(`#${fragment}`);
    for (const hit of serverHits) {
      expect(hit).not.toContain(fragment);
      expect(hit).not.toContain("#");
    }
  });
});
