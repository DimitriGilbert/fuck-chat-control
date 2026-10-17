import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";

import type { ThemePreference } from "@/features/chat/ui/theme";

interface ThemeOption {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: React.ReactElement;
}

const OPTIONS: readonly ThemeOption[] = [
  { value: "system", label: "System", icon: <MonitorIcon aria-hidden="true" /> },
  { value: "light", label: "Light", icon: <SunIcon aria-hidden="true" /> },
  { value: "dark", label: "Dark", icon: <MoonIcon aria-hidden="true" /> },
];

/**
 * Tri-state appearance picker (system | light | dark) rendered as a
 * segmented radiogroup. Backed by next-themes: the choice persists to
 * localStorage and "system" tracks `prefers-color-scheme`.
 *
 * The control is only interactive after mount: during SSR the resolved
 * theme is unknown (it lives in localStorage / the media query), so the
 * first render shows the segmented frame with no checked option rather than
 * a hydrated-mismatch lie. The settings sheet that hosts this only opens
 * client-side anyway, so the empty frame is effectively never seen — it
 * exists to keep a direct render honest.
 */
export function ThemeControl(): React.ReactElement {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const current: ThemePreference | null =
    mounted && (theme === "system" || theme === "light" || theme === "dark") ? theme : null;

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      data-testid="theme-control"
      className="border-border flex overflow-hidden rounded-none border"
    >
      {OPTIONS.map((option) => {
        const checked = current === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!mounted}
            onClick={() => setTheme(option.value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:z-10 focus-visible:ring-1 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5",
              checked
                ? "bg-primary text-primary-foreground"
                : "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
