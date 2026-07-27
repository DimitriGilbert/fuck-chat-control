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
      // Open Graph / social preview. og:image is root-relative; modern crawlers
      // (Facebook, X/Twitter, Slack, Discord) resolve it against the page URL.
      // If a fixed production domain is added later, make these absolute.
      {
        property: "og:title",
        content: "fck-chat-control",
      },
      {
        property: "og:type",
        content: "website",
      },
      {
        property: "og:image",
        content: "/og.png",
      },
      {
        property: "og:image:width",
        content: "1536",
      },
      {
        property: "og:image:height",
        content: "1024",
      },
      {
        name: "twitter:card",
        content: "summary_large_image",
      },
      {
        name: "twitter:image",
        content: "/og.png",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "icon",
        type: "image/png",
        href: "/icon.png",
      },
      {
        rel: "apple-touch-icon",
        href: "/icon.png",
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
 *
 * The dynamic export is stored in state. `setState` treats a function-valued
 * payload as an updater (`(prev) => next`), so passing the component type
 * directly would make React invoke it with the previous state (null) as its
 * argument — the source of the original `Cannot destructure property
 * 'initialIsOpen' of 'props' as it is null` throw. We wrap the component in
 * an arrow updater so React stores it rather than calling it.
 *
 * A React error boundary sits around the rendered devtools as a defensive
 * floor: devtools are non-critical chrome, and any throw (version skew,
 * missing context, future regression) must never blank the chat shell or break
 * an e2e run.
 */
type DevToolsPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
interface DevToolsProps {
  readonly position?: DevToolsPosition;
  readonly initialIsOpen?: boolean;
}
type DevToolsComponent = React.ComponentType<DevToolsProps>;

interface DevToolsBoundaryState {
  readonly failed: boolean;
}

class DevToolsBoundary extends React.Component<
  { readonly children: React.ReactNode },
  DevToolsBoundaryState
> {
  state: DevToolsBoundaryState = { failed: false };

  static getDerivedStateFromError(): DevToolsBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    // Swallow: devtools are non-functional chrome and must never surface a
    // visible error to the user. The boundary exists precisely so a devtools
    // throw cannot blank the chat shell or break an e2e run.
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function DevToolsGate(): React.ReactElement | null {
  const [DevTools, setDevTools] = React.useState<DevToolsComponent | null>(null);

  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("@tanstack/react-router-devtools")
      .then((mod: { TanStackRouterDevtools: DevToolsComponent }): void => {
        if (cancelled) return;
        // Wrap in an arrow updater: React treats a function-valued setState
        // payload as a state updater, so passing the component directly would
        // invoke it with the previous state (null) — the very throw this gate
        // originally caused. The arrow returns the component as the next
        // state value rather than calling it.
        setDevTools(() => mod.TanStackRouterDevtools);
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
  return (
    <DevToolsBoundary>
      <DevTools position="bottom-right" />
    </DevToolsBoundary>
  );
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
