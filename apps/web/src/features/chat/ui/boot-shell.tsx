import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { Loader2Icon, LockIcon, Settings2Icon } from "lucide-react";
import * as React from "react";

/**
 * Static first-paint replica of the app shell, rendered as the `/` route's
 * `pendingComponent`. The route match stays pending for the whole SSR pass
 * (the old `defaultPendingComponent` spinner was the ENTIRE server payload —
 * ~2s of empty page while the JS bundle arrived). This markup ships in the
 * HTML instead: real layout, real copy, and a disabled CTA in the same
 * "Setting up secure storage…" state the live button boots into, so the
 * swap to the hydrated app is nearly invisible.
 *
 * Deliberately hook-free and dependency-light: it renders inside the
 * suspended boundary on the server, so anything that reads chat state,
 * mounts a base-ui popup root, or touches the DOM is off-limits.
 */
export function BootShell(): React.ReactElement {
  return (
    <div className="bg-background text-foreground flex h-dvh">
      {/* Rail — desktop only; the mobile shell's home is the rail, and the
          centered card already covers the small-screen first impression. */}
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden h-full w-64 flex-col border-r md:flex">
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <a
            href="/"
            className="text-sidebar-foreground text-sm font-semibold tracking-tight hover:opacity-80"
            aria-label="fuck-chat-control home"
          >
            <span className="text-sidebar-primary">fuck</span>
            <span className="text-sidebar-foreground">-chat-control</span>
          </a>
        </div>
        <div className="px-2 pb-2">
          <Button variant="default" size="sm" className="w-full justify-start" disabled>
            <Loader2Icon className="animate-spin" />
            Setting up secure storage…
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
          <p className="text-sidebar-foreground/60 px-3 py-6 text-center text-xs">
            No conversations yet. Start one to get a link.
          </p>
        </div>
        <div className="border-sidebar-border border-t px-2 py-2">
          <Button variant="ghost" size="icon-sm" aria-label="Open settings" disabled>
            <Settings2Icon />
          </Button>
        </div>
      </aside>

      {/* Main pane — the empty-state card, static copy identical to
          SecurityStory so hydration reads as a no-op. */}
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center px-4">
        <div className="bg-card border-border mx-auto flex w-full max-w-[480px] flex-col items-center gap-5 rounded-xl border p-8 text-center shadow-sm">
          <div className="bg-primary/10 text-primary mb-1 flex size-10 items-center justify-center rounded-lg">
            <LockIcon className="size-5" aria-hidden="true" />
          </div>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">
            Private chat, no account.
          </h1>
          <div className="flex max-w-[40ch] flex-col gap-3">
            <p className="text-muted-foreground text-sm leading-6">
              Start a 1:1 conversation and share the link. Both of you must be online at the same
              time — there is no server holding messages for later. Once connected, everything is
              end-to-end encrypted and the server only ever relays the handshake.
            </p>
            <p className="text-muted-foreground text-sm leading-6">
              Read the{" "}
              <a href="/docs/security" className="text-primary underline underline-offset-4">
                security notes
              </a>{" "}
              before relying on it for anything sensitive.
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            className="h-8 w-full justify-center"
            disabled
            aria-busy="true"
          >
            <Loader2Icon className="animate-spin" />
            Setting up secure storage…
          </Button>
        </div>
      </main>
    </div>
  );
}
