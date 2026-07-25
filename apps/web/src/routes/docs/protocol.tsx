import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/components/docs-layout";
import { Markdown } from "@/components/markdown";
import protocolSource from "../../../../../docs/architecture/protocol-v1.md?raw";

export const Route = createFileRoute("/docs/protocol")({
  component: ProtocolComponent,
});

function ProtocolComponent() {
  return (
    <DocsLayout title="Protocol v1 specification" activePath="/docs/protocol">
      <Markdown source={protocolSource} />
    </DocsLayout>
  );
}
