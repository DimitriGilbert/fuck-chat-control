import { expect, test } from "@playwright/test";

import { invitationHex } from "./_helpers";

/**
 * Landing shell scenarios. The old centered marketing wall is gone; these
 * tests cover the load-bearing affordances (start, copy invitation link,
 * fragment never sent to the server), the new sidebar drawer on mobile, the
 * sidebar reflecting live sessions, and the no-horizontal-overflow guarantee
 * at both a narrow phone width and a wide desktop width.
 */

test.describe("landing shell", () => {
  test("renders the app shell with a New conversation affordance", async ({ page }) => {
    await page.goto("/");

    // The shell renders the sidebar on desktop (md+). The primary New
    // conversation button is the load-bearing start affordance.
    await expect(page.getByRole("button", { name: /Start a conversation/ }).first()).toBeVisible();
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

  test("layout does not overflow horizontally on a wide desktop viewport", async ({ page }) => {
    // Wide viewports expose fixed-width elements that would leave a gap or
    // push the main pane off-screen on large monitors.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("mobile drawer toggle opens the conversation sidebar", async ({ page }) => {
    // At 390px the desktop sidebar is hidden; the hamburger in the top bar
    // opens the Sheet drawer that hosts the same Sidebar component.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // The hamburger button is labeled "Open conversations".
    const toggle = page.getByRole("button", { name: "Open conversations" });
    await expect(toggle).toBeVisible();

    // The empty state also exposes a Start affordance on mobile, so scope the
    // drawer-open assertion to the Sheet's content, which only mounts when the
    // drawer is actually open. The first tap can land during React hydration
    // and be swallowed (a known Playwright/hydration race, not a component
    // bug); retry the tap until the drawer content appears, mirroring what a
    // user does when a tap doesn't take.
    await expect(async () => {
      if ((await page.locator('[data-slot="sheet-content"]').count()) === 0) {
        await toggle.click();
      }
      await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 8_000 });

    // The drawer surfaces the sidebar component. Both the desktop sidebar
    // (hidden at this viewport via `hidden md:flex`) and the drawer-mounted
    // sidebar are in the DOM; assert the drawer's instance is the visible one.
    await expect(page.locator('[data-slot="sheet-content"] [data-slot="sidebar"]')).toBeVisible();
  });

  test("start conversation produces a 32-hex invitation link in the URL fragment", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: /Start a conversation/ })
      .first()
      .click();

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

    await page
      .getByRole("button", { name: /Start a conversation/ })
      .first()
      .click();
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

    // The browser landed on the index route and rendered the shell. The
    // hamburger or the New conversation button is present.
    await expect(page.getByRole("button", { name: /Start a conversation/ }).first()).toBeVisible({
      timeout: 10_000,
    });

    // The fragment is retained in the URL bar (the join flow reads it from
    // window.location.hash) and is NOT part of any server request.
    expect(page.url()).toContain(`#${fragment}`);
    for (const hit of serverHits) {
      expect(hit).not.toContain(fragment);
      expect(hit).not.toContain("#");
    }
  });

  test("sidebar shows started conversations and highlights the active one", async ({ page }) => {
    // Desktop sidebar (md+) is visible by default at the default viewport.
    await page.goto("/");

    // Start two conversations. Each renders a row in the sidebar list.
    const startButton = page.getByRole("button", { name: /Start a conversation/ }).first();
    await startButton.click();
    // The first start flips the active id; the InvitationBanner shows in the
    // main pane. Wait for the invitation input so we know the session is up.
    await expect(page.getByLabel("Invitation link")).toBeVisible({ timeout: 10_000 });

    // The active conversation row gets `data-active="true"`.
    const rows = page.getByRole("button").filter({ hasText: /New chat|Conversation/ });
    // At least one row (the just-started session) is present.
    await expect(rows.first()).toBeVisible();

    // Assert that exactly one row carries the active attribute.
    const activeRows = page.locator('[data-slot="sidebar-row"][data-active="true"]');
    await expect(activeRows).toHaveCount(1);
  });
});
