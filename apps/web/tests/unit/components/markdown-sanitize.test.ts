// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "@/components/markdown";

/**
 * R12/F1: marked output is sanitized with DOMPurify before being injected via
 * `dangerouslySetInnerHTML`. The docs source is repo-local, but the gate is
 * defense-in-depth — a payload snuck in via a docs edit must be stripped at
 * render time, not rendered as active content.
 */
describe("renderMarkdown sanitization (R12/F1)", () => {
  it("renders a plain paragraph unchanged", () => {
    const out = renderMarkdown("hello world");
    expect(out).toContain("hello world");
    expect(out).toContain("<p>");
    expect(out).toContain("</p>");
  });

  it("preserves relative links and rewrites known docs targets", () => {
    const out = renderMarkdown("[protocol](protocol-v1.md)");
    expect(out).toContain('href="/docs/protocol"');
    expect(out).toContain(">protocol</a>");
  });

  it("keeps external http(s) links with target=_blank", () => {
    const out = renderMarkdown("[ex](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer"');
  });

  it("strips an inline <script> injected via marked inline-HTML", () => {
    const out = renderMarkdown("hello <script>alert(1)</script> world");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    // The surrounding text still renders.
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("rejects a javascript: scheme in a markdown link href", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    // Either the link was rewritten to "#" by resolveDocsHref (defensive
    // pre-sanitizer step) or DOMPurify stripped it. Either way the active
    // scheme must not appear in the rendered HTML.
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out.toLowerCase()).not.toContain("alert(1)");
  });

  it("rejects a data: URL with an HTML payload in a markdown link", () => {
    const out = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(out.toLowerCase()).not.toContain("data:");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("alert(1)");
  });

  it("strips inline event handlers from inline HTML", () => {
    const out = renderMarkdown('<img src="x.png" onerror="alert(1)" />');
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out.toLowerCase()).not.toContain("alert(1)");
  });

  it("does not execute or preserve a script that builds an iframe", () => {
    const out = renderMarkdown('text <iframe src="javascript:alert(1)"></iframe> more');
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out.toLowerCase()).not.toContain("alert(1)");
    // text content survives.
    expect(out).toContain("text");
    expect(out).toContain("more");
  });

  it("fragment-only links are preserved", () => {
    const out = renderMarkdown("[jump](#section)");
    expect(out).toContain('href="#section"');
  });

  it("mailto and tel links are preserved", () => {
    const mail = renderMarkdown("[mail](mailto:a@b.example)");
    expect(mail).toContain('href="mailto:a@b.example"');
  });
});
