import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
const SRC_ROOT = fileURLToPath(new URL("../../../src", import.meta.url));
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
    expect(
      nonDocs.map((f) => relative(SRC_ROOT, f)),
    ).toEqual([]);
  });

  it("every importer pulls its source via a ?raw docs/ import", () => {
    for (const f of importers) {
      const content = readFileSync(f, "utf8");
      const match = content.match(
        /import\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']*\.md\?raw)["']/,
      );
      const sourcePath = match?.[1] ?? "";
      expect(
        sourcePath,
        `${relative(SRC_ROOT, f)} must import a *.md?raw module`,
      ).toBeTruthy();
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
    expect(
      offenders.map((f) => relative(SRC_ROOT, f)),
    ).toEqual([]);
  });
});
