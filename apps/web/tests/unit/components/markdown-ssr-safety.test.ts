// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { renderMarkdown } from "@/components/markdown";

/**
 * LW-25 (SSR hardening): the docs renderer's SSR/prerender path skips
 * DOMPurify (it is browser-only — it walks the DOM to sanitize, so without a
 * `window` there is nothing to walk). That passthrough is safe ONLY because
 * every input that reaches `renderMarkdown` is a `?raw` import of
 * repo-authored markdown from `docs/` consumed by a docs route — never
 * peer-controlled chat text. Chat messages are rendered as plain text by
 * `BubbleContent` (see `src/features/chat/ui/chat-view.tsx`) and must never
 * flow through marked.
 *
 * This test pins the trusted-input scope at the source level so a future
 * change cannot quietly widen the surface and reintroduce a pre-hydration XSS
 * window. If you intentionally route a new (still-trusted) source through
 * `<Markdown>`, add it under `src/routes/docs/` with its own `?raw` import —
 * do NOT relax the "no non-docs importer" rule.
 */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src");
const MARKDOWN_MODULE = "components/markdown.tsx";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".output" || entry === "dist") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

/** True if `file` imports the `components/markdown` module. */
function importsMarkdownModule(content: string): boolean {
  // Match the `from "..."` clause so any import shape (default, named, aliased,
  // type-only) is caught, while rejecting sibling names like
  // `components/markdown-sanitize`.
  return /from\s+["'][^"']*components\/markdown["']/.test(content);
}

describe("LW-25: renderMarkdown input surface is trusted docs only", () => {
  const allFiles = walk(SRC_ROOT);

  const importers = allFiles.filter((f) => {
    if (relative(SRC_ROOT, f) === MARKDOWN_MODULE) return false;
    return importsMarkdownModule(readFileSync(f, "utf8"));
  });

  it("has at least one docs importer (guards against a silent module rename)", () => {
    // If this fails, either the docs routes were deleted or the markdown
    // module moved — either way the LW-25 safety argument needs re-auditing.
    expect(importers.length).toBeGreaterThan(0);
  });

  it("every importer of components/markdown lives under src/routes/docs", () => {
    const nonDocs = importers.filter(
      (f) => !relative(SRC_ROOT, f).startsWith(join("routes", "docs") + "/"),
    );
    expect(nonDocs.map((f) => relative(SRC_ROOT, f))).toEqual([]);
  });

  it("every importer pulls its source via a ?raw docs/ import", () => {
    for (const f of importers) {
      const content = readFileSync(f, "utf8");
      const match = content.match(/import\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']*\.md\?raw)["']/);
      const sourcePath = match?.[1] ?? "";
      expect(sourcePath, `${relative(SRC_ROOT, f)} must import a *.md?raw module`).toBeTruthy();
      expect(
        sourcePath.includes("/docs/"),
        `${relative(SRC_ROOT, f)}: ?raw import "${sourcePath}" must resolve under docs/`,
      ).toBe(true);
    }
  });

  it("no source file outside components/markdown.tsx references renderMarkdown", () => {
    // `renderMarkdown` is exported for direct sanitization coverage
    // (markdown-sanitize.test.ts). Production use must flow through
    // `<Markdown>` in a docs route; finding the symbol elsewhere means a
    // non-docs caller bypassed the route-level input contract.
    const offenders = allFiles.filter((f) => {
      if (relative(SRC_ROOT, f) === MARKDOWN_MODULE) return false;
      const content = readFileSync(f, "utf8");
      return /\brenderMarkdown\b/.test(content);
    });
    expect(offenders.map((f) => relative(SRC_ROOT, f))).toEqual([]);
  });
});

/**
 * R6F2: the custom link renderer builds its anchor by string interpolation,
 * and the resolved href used to be interpolated unescaped. marked's
 * angle-bracket link form carries quotes and spaces through the parser
 * (`[x](<foo" onmouseover="alert(1)>)`), `resolveDocsHref` passes the
 * scheme-less href through unchanged, and the raw `"` broke out of the href
 * attribute — the verifier reproduced `<a href="foo" onmouseover="alert(1)">x</a>`.
 * The renderer now HTML-attribute-escapes the href, which must hold on BOTH
 * render paths: the SSR passthrough (no `window`, so DOMPurify is skipped and
 * the marked output ships as-is) and the client path (DOMPurify sanitize).
 *
 * This file runs under jsdom for the client path; the SSR branch is
 * exercised by stubbing `window` to undefined for the call —
 * `renderMarkdown` evaluates `typeof window` at call time, so the stub
 * selects the raw-passthrough branch without re-importing the module.
 */
const BREAKOUT_SOURCE = '[x](<foo" onmouseover="alert(1)>)';
const BREAKOUT_HREF = 'foo" onmouseover="alert(1)';
const ESCAPED_ANCHOR = '<a href="foo&quot; onmouseover=&quot;alert(1)">x</a>';

function requireAnchor(html: string): HTMLAnchorElement {
  const anchor = new DOMParser().parseFromString(html, "text/html").querySelector("a");
  if (anchor === null) {
    throw new Error(`expected an <a> element in rendered output: ${html}`);
  }
  return anchor;
}

describe("R6F2: link renderer href attribute breakout", () => {
  it("SSR path: the href quote is escaped, no injectable attribute", () => {
    vi.stubGlobal("window", undefined); // force the SSR/prerender branch
    try {
      const out = renderMarkdown(BREAKOUT_SOURCE);
      // Raw passthrough: the payload's `"` must render as &quot; — with the
      // quote escaped the HTML attribute grammar cannot form a second
      // attribute out of " onmouseover=...".
      expect(out).toContain(ESCAPED_ANCHOR);
      const anchor = requireAnchor(out);
      expect(anchor.getAttribute("href")).toBe(BREAKOUT_HREF);
      expect(anchor.getAttribute("onmouseover")).toBeNull();
      expect(anchor.getAttributeNames()).toEqual(["href"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("client path: DOMPurify branch neutralizes the payload too", () => {
    // Control: prove the DOMPurify branch is live in this module instance —
    // otherwise both tests would silently exercise the raw passthrough.
    expect(renderMarkdown("a <script>alert(1)</script> b")).not.toContain("<script");
    const out = renderMarkdown(BREAKOUT_SOURCE);
    const anchor = requireAnchor(out);
    expect(anchor.getAttribute("href")).toBe(BREAKOUT_HREF);
    expect(anchor.getAttribute("onmouseover")).toBeNull();
    expect(anchor.getAttributeNames()).toEqual(["href"]);
  });
});
