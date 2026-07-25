import { Link } from "@tanstack/react-router";
import * as React from "react";

const NAV: ReadonlyArray<readonly [string, string]> = [
  ["Docs", "/docs"],
  ["Security", "/docs/security"],
  ["Threat model", "/docs/threat-model"],
  ["Protocol v1", "/docs/protocol"],
  ["Deployment", "/docs/deployment"],
];

export interface DocsLayoutProps {
  title: string;
  /** Active nav entry, used to render the "you are here" state. */
  activePath: string;
  children: React.ReactNode;
}

export function DocsLayout({ title, activePath, children }: DocsLayoutProps): React.ReactElement {
  return (
    <main className="min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-10">
        <nav aria-label="Docs" className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Link to="/" className="text-muted-foreground underline-offset-4 hover:underline">
            ← Home
          </Link>
          <span className="text-muted-foreground/50">/</span>
          {NAV.map(([label, to]) => {
            const active = to === activePath;
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "font-medium text-foreground underline underline-offset-4"
                    : "text-muted-foreground underline-offset-4 hover:underline"
                }
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <header className="mb-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            fuck-eu-chat-control docs
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        </header>

        {children}
      </div>
    </main>
  );
}
