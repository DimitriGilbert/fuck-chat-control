import { Toaster } from "@fuck-eu-chat-control/ui/components/sonner";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import * as React from "react";

import { ChatProvider } from "@/features/chat/runtime/chat-provider";

import appCss from "../index.css?url";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "fck-chat-control",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  component: RootDocument,
});

/**
 * R12/F2: TanStackRouterDevtools is gated on `import.meta.env.DEV` and loaded
 * via a dynamic import so it is excluded from the production bundle. The static
 * import pulled the devtools (and its heavy inspector deps) into every prod
 * build. The lazy guard below resolves the module only in dev; in prod the
 * branch is dead and the bundler drops the import entirely.
 *
 * `@tanstack/react-router-devtools` is browser-only (touches `window`), so the
 * dynamic import lives inside a `useEffect` to keep SSR safe.
 */
type DevToolsPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
type DevToolsComponent = React.ComponentType<{ position?: DevToolsPosition }>;

function DevToolsGate(): React.ReactElement | null {
  const [DevTools, setDevTools] = React.useState<DevToolsComponent | null>(null);

  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("@tanstack/react-router-devtools")
      .then((mod: { TanStackRouterDevtools: DevToolsComponent }): void => {
        if (cancelled) return;
        setDevTools(mod.TanStackRouterDevtools);
      })
      .catch((): void => {
        // best-effort; devtools are non-functional chrome.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (!import.meta.env.DEV) return null;
  if (DevTools === null) return null;
  return <DevTools position="bottom-right" />;
}

function RootDocument() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <ChatProvider>
          {/* The shell (routes/index.tsx) and the docs routes each own their
              own full-viewport layout; the root just provides the outlet. No
              wrapping chrome here, or docs pages would inherit a chat sidebar. */}
          <Outlet />
        </ChatProvider>
        <Toaster richColors />
        {/* bottom-right so the devtools bubble does not overlap the sidebar's
            bottom-left Settings entry. Dev-only — excluded from prod bundle. */}
        <DevToolsGate />
        <Scripts />
      </body>
    </html>
  );
}
