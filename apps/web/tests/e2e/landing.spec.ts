import { expect, test } from "@playwright/test";

import { invitationHex, TID, startConversationButton, invitationLinkInput } from "./_helpers";

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
    await expect(startConversationButton(page)).toBeVisible({
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

  test("mobile is list-first and the chat pushes over it", async ({ page }) => {
    // At 390px the conversation list is the home surface — no drawer, no
    // hamburger. Starting a conversation pushes the chat pane over the list;
    // the back button returns to the list.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // The mobile home renders the same sidebar component inline, with its own
    // start affordance (distinct test id from the desktop rail's).
    const start = page.getByTestId(TID.startConversationMobile);
    await expect(start).toBeVisible({ timeout: 10_000 });
    await start.click();

    // The chat pushes over: the invitation link input appears inside the
    // covering main pane, and the back affordance is present.
    await expect(invitationLinkInput(page)).toBeVisible({ timeout: 10_000 });
    const back = page.getByTestId(TID.backToConversations);
    await expect(back).toBeVisible();

    // Back returns to the list WITHOUT leaving the session — the row is
    // still there and re-tapping it re-opens the chat.
    await back.click();
    const list = page.getByTestId(TID.conversationList);
    await expect(list).toBeVisible();
    await list.getByRole("button").first().click();
    await expect(invitationLinkInput(page)).toBeVisible({ timeout: 10_000 });
  });

  test("start conversation produces a 32-hex invitation link in the URL fragment", async ({
    page,
  }) => {
    await page.goto("/");
    await startConversationButton(page).click();

    const invitationInput = invitationLinkInput(page);
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

    await startConversationButton(page).click();
    await page.getByRole("button", { name: /Copy link/ }).click();

    if (browserName === "chromium") {
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toMatch(/#[0-9a-f]{32}$/);
    } else {
      // The button admits "Copied" — writeText resolved without throwing.
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible({ timeout: 5_000 });
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
    await expect(startConversationButton(page)).toBeVisible({
      timeout: 10_000,
    });

    // The join flow parsed the fragment client-side: the join-mode chooser
    // (1:1 vs group — protocol-v2 §8) is the visible proof. Consuming the
    // fragment also scrubs it from the URL bar (R11F2), so the credential
    // does not linger in history — an even stronger guarantee than retention.
    await expect(page.getByTestId(TID.joinAsPair)).toBeVisible({ timeout: 10_000 });
    expect(page.url()).not.toContain(fragment);
    expect(page.url()).not.toContain("#");

    // The fragment is NOT part of any server request.
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
    // fragment client-side — the join-mode chooser is the visible proof, and
    // consuming the fragment scrubs the credential-laden hash from the URL
    // bar (R11F2) so it cannot leak through history or a later copy.
    await expect(startConversationButton(page)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId(TID.joinAsPair)).toBeVisible({ timeout: 10_000 });
    expect(page.url()).not.toContain(hex);
    expect(page.url()).not.toContain("~");
    expect(page.url()).not.toContain(code);

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
    const startButton = startConversationButton(page);
    await startButton.click();
    // The first start flips the active id; the InvitationBanner shows in the
    // main pane. Wait for the invitation input so we know the session is up.
    await expect(invitationLinkInput(page)).toBeVisible({ timeout: 10_000 });

    // The active conversation row gets `data-active="true"`.
    const rows = page.getByRole("button").filter({ hasText: /New chat|Conversation/ });
    // At least one row (the just-started session) is present.
    await expect(rows.first()).toBeVisible();

    // Assert that exactly one row carries the active attribute. The sidebar
    // mounts twice (desktop rail + mobile list-first home) so scope the
    // lookup inside the first "Chats" navigation landmark.
    const activeRows = page
      .getByRole("navigation", { name: "Chats" })
      .first()
      .locator('[data-slot="sidebar-row"][data-active="true"]');
    await expect(activeRows).toHaveCount(1);
  });
});
