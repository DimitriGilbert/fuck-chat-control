import { Loader2 } from "lucide-react";

export default function Loader() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      className="flex h-full items-center justify-center pt-8"
    >
      <Loader2 className="animate-spin" />
    </div>
  );
}
