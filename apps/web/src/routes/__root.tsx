import { Toaster } from "@fuck-eu-chat-control/ui/components/sonner";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

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
            bottom-left Settings entry (the e2e dev server keeps devtools visible). */}
        <TanStackRouterDevtools position="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
