import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import * as React from "react";

/**
 * Render trusted local markdown (sourced from this repo's `docs/` via Vite
 * `?raw` imports) as HTML. Inline HTML is sanitized with DOMPurify before
 * rendering, so any payload that snuck in via a docs edit is stripped at
 * render time. The source is author-controlled at build time; it never sees
 * untrusted user input.
 */
marked.setOptions({
  gfm: true,
  breaks: false,
  async: false,
});

marked.use({
  renderer: {
    // The markdown's relative links (../adr/..., protocol-v1.md) become
    // pointers to the docs routes this app exposes.
    link({ href, tokens }: Tokens.Link): string {
      // `text` needs no escaping here: `parser.parseInline` already
      // HTML-escapes text tokens (`"` -> &quot;, `&` -> &amp;) for both the
      // plain and angle-bracket link forms, and raw inline HTML inside link
      // text is stock-marked passthrough that the DOMPurify stage strips on
      // the client path (the SSR path trusts only repo docs, per LW-25). The
      // href is the only attribute-context interpolation, so it alone is
      // attribute-escaped.
      const text = this.parser.parseInline(tokens);
      const resolved = resolveDocsHref(href ?? "");
      const target = resolved.startsWith("http") ? ' target="_blank" rel="noreferrer"' : "";
      return `<a href="${escapeHtmlAttribute(resolved)}"${target}>${text}</a>`;
    },
  },
});

/**
 * Reject dangerous URL schemes before the renderer interpolates `resolved`
 * into the anchor's `href`. DOMPurify strips `javascript:` URLs downstream,
 * but we also reject here so the link stays observable in its safe form even
 * if a future caller bypasses the sanitizer.
 */
function resolveDocsHref(href: string): string {
  if (!href) return href;
  if (hasDangerousScheme(href)) return "#";
  if (href.startsWith("#")) return href;
  if (href.includes("threat-model.md")) return "/docs/threat-model";
  if (href.includes("protocol-v1.md")) return "/docs/protocol";
  if (href.includes("deployment.md")) return "/docs/deployment";
  if (href.includes("001-crypto-dependencies.md")) return "/docs/security#adrs";
  return href;
}

/**
 * Escape a value for interpolation into a double-quoted HTML attribute
 * context (R6F2). `resolveDocsHref` passes unrecognized hrefs through
 * unchanged and `hasDangerousScheme` admits scheme-less hrefs, so a `"`
 * carried through marked's angle-bracket link form
 * (`[x](<foo" onmouseover="alert(1)>)`) would otherwise break out of
 * `href="..."` and inject an attribute. DOMPurify catches that on the client
 * path, but the SSR path returns marked output unsanitized, so the escape
 * must happen here. Order matters: it is applied after scheme resolution
 * (the checks must see the true href) and before template interpolation, and
 * `&` is replaced first so the other replacements are not double-escaped.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * A scheme is dangerous when it can resolve to script execution or other
 * active content (javascript:, data: with HTML/XML, vbscript:, etc.). We
 * accept the relative-link and http(s)/mailto forms the docs use and reject
 * everything else via a colon-prefix check on the lowercased scheme.
 */
function hasDangerousScheme(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  // Relative refs (no scheme) and fragment-only links have no colon before
  // the first slash, hash, or query — they are safe.
  const colonAt = trimmed.indexOf(":");
  if (colonAt === -1) return false;
  const hashAt = trimmed.indexOf("#");
  if (hashAt !== -1 && hashAt < colonAt) return false;
  const slashAt = trimmed.indexOf("/");
  if (slashAt !== -1 && slashAt < colonAt) return false;
  const questionAt = trimmed.indexOf("?");
  if (questionAt !== -1 && questionAt < colonAt) return false;
  const scheme = trimmed.slice(0, colonAt);
  const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
  return !SAFE_SCHEMES.has(scheme);
}

/**
 * Run marked, then strip anything DOMPurify does not allow in the HTML
 * profile. Exported so the sanitization step has direct test coverage
 * independent of the React component. `target` and `rel` are allowed on
 * anchors so the link renderer's `target="_blank" rel="noreferrer"` for
 * external links survives sanitization.
 *
 * TRUSTED-DOCS SCOPE: this renderer is used ONLY by the docs routes, which
 * consume trusted repo-authored markdown (`?raw` imports from `docs/`).
 * Chat messages do NOT flow through it — incoming peer text is rendered by
 * BubbleContent, which treats message content as plain text and lets React
 * escape it, so untrusted markup never reaches marked or DOMPurify. Keep it
 * that way: do not route peer-controlled text through `renderMarkdown`.
 *
 * DOMPurify is browser-only (it walks the DOM to sanitize). At SSR/prerender
 * time there is no `window`, so `DOMPurify.sanitize` is undefined and calling
 * it throws. Because the only consumer is the trusted docs route (whose
 * source is author-controlled at build time), SSR passthrough of the marked
 * output is safe in that single context. In the browser the DOM exists, the
 * guard passes, and the sanitization security property (R12/F1) is enforced.
 *
 * LW-25 SAFETY CONTRACT: the SSR passthrough above is safe ONLY because every
 * input reaching this function is a `?raw` import of repo-authored markdown
 * from `docs/`, consumed by a `src/routes/docs/*` route. That scope is pinned
 * by `tests/unit/components/markdown-ssr-safety.test.ts` (every importer must
 * live under `src/routes/docs` and pull its source via a `*.md?raw` import;
 * no non-docs file may reference `renderMarkdown`). Do not widen the input
 * surface without re-auditing the pre-hydration window.
 */
export function renderMarkdown(source: string): string {
  const raw = marked.parse(source, { async: false }) as string;
  if (typeof window === "undefined" || typeof DOMPurify?.sanitize !== "function") {
    return raw;
  }
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
  });
}

export interface MarkdownProps {
  source: string;
  className?: string;
}

export function Markdown({ source, className }: MarkdownProps): React.ReactElement {
  const html = React.useMemo(() => renderMarkdown(source), [source]);

  return (
    <div
      className={["docs-prose", className].filter(Boolean).join(" ")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
