import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/components/docs-layout";
import { Markdown } from "@/components/markdown";
import protocolSource from "../../../../../docs/architecture/protocol-v2-group.md?raw";

export const Route = createFileRoute("/docs/protocol-group")({
  component: ProtocolGroupComponent,
});

function ProtocolGroupComponent() {
  return (
    <DocsLayout title="Protocol v2 — group chats" activePath="/docs/protocol-group">
      <Markdown source={protocolSource} />
    </DocsLayout>
  );
}
