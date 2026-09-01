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
    // The production prerender of `/` aborts the SSR Suspense boundary (React
    // #419 — see FAILURE-react-419.md) and the client recovers by re-rendering
    // the whole shell from scratch. That cold-client-recovery path can push
    // the button's first paint past the default 5s `toBeVisible` timeout on a
    // loaded/CI machine, so allow the same 10s the fragment tests below grant
    // for the identical selector. Dev mode renders in ~2s and is unaffected.
    await expect(page.getByRole("button", { name: /Start a conversation/ }).first()).toBeVisible({
      timeout: 10_000,
    });
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
    // Same React #419 cold-client-render caveat as the shell test above: the
    // mobile top bar (hamburger included) only mounts after the client-render
    // recovery completes, which can exceed the default 5s on a loaded machine.
    const toggle = page.getByRole("button", { name: "Open conversations" });
    await expect(toggle).toBeVisible({ timeout: 10_000 });

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

  /**
   * LW-23 / LW-24 (Phase 7b): a coded invitation carries a 6-digit PAKE code
   * after the conversation id, separated by `~` (e.g. `#<hex>~<digits>`). The
   * `~code` is the password-derived secret's input and MUST NEVER reach the
   * server — the broker is signaling-only and must not see the code. The
   * browser keeps the whole hash (hex + ~ + digits) client-side; this test
   * asserts via a request log that neither the `~` separator, the digit code,
   * nor the hex id appears in any server-visible path or query.
   */
  test("a coded invitation (#hex~digits) loads the index route; the ~code never reaches the server", async ({
    page,
  }) => {
    const hex = "0123456789abcdef0123456789abcdef";
    const code = "123456";
    const fragment = `${hex}~${code}`;
    const serverHits: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("localhost:3001")) {
        serverHits.push(new URL(url).pathname + new URL(url).search);
      }
    });

    await page.goto(`http://localhost:3001/#${fragment}`);

    // The shell rendered; the join flow parsed the coded invitation from the
    // fragment client-side.
    await expect(page.getByRole("button", { name: /Start a conversation/ }).first()).toBeVisible({
      timeout: 10_000,
    });

    // The full coded invitation (hex + ~ + digits) is retained in the URL bar
    // for the client-side join flow to consume.
    expect(page.url()).toContain(`#${fragment}`);

    // The server never sees the fragment at all: not the hex id, not the `~`
    // separator, not the digit code, and no literal `#`. The `~` and the digit
    // code are the load-bearing exclusions here — a regression that sent the
    // hash to the server (e.g. via a malformed fetch that included location.hash)
    // would leak the PAKE code.
    for (const hit of serverHits) {
      expect(hit).not.toContain(hex);
      expect(hit).not.toContain("~");
      expect(hit).not.toContain(code);
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
