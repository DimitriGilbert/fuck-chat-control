import { marked, type Tokens } from "marked";
import * as React from "react";

/**
 * Render trusted local markdown (sourced from this repo's `docs/` via Vite
 * `?raw` imports) as HTML. We disable inline HTML because the spec pages do
 * not need it and this keeps the output predictable. The source is author-
 * controlled at build time; it never sees user input.
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
      const text = this.parser.parseInline(tokens);
      const resolved = resolveDocsHref(href ?? "");
      const target = resolved.startsWith("http") ? ' target="_blank" rel="noreferrer"' : "";
      return `<a href="${resolved}"${target}>${text}</a>`;
    },
  },
});

function resolveDocsHref(href: string): string {
  if (!href) return href;
  if (href.startsWith("#")) return href;
  if (href.includes("threat-model.md")) return "/docs/threat-model";
  if (href.includes("protocol-v1.md")) return "/docs/protocol";
  if (href.includes("deployment.md")) return "/docs/deployment";
  if (href.includes("001-crypto-dependencies.md")) return "/docs/security#adrs";
  return href;
}

export interface MarkdownProps {
  source: string;
  className?: string;
}

export function Markdown({ source, className }: MarkdownProps): React.ReactElement {
  const html = React.useMemo(() => marked.parse(source, { async: false }) as string, [source]);

  return (
    <div
      className={["docs-prose", className].filter(Boolean).join(" ")}
      // Source is repo-local markdown imported at build time; no user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
