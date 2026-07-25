import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/components/docs-layout";
import { Markdown } from "@/components/markdown";
import threatModelSource from "../../../../../docs/architecture/threat-model.md?raw";

export const Route = createFileRoute("/docs/threat-model")({
  component: ThreatModelComponent,
});

function ThreatModelComponent() {
  return (
    <DocsLayout title="Threat model" activePath="/docs/threat-model">
      <Markdown source={threatModelSource} />
    </DocsLayout>
  );
}
