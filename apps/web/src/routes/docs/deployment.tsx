import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/components/docs-layout";
import { Markdown } from "@/components/markdown";
import deploymentSource from "../../../../../docs/deployment/deployment.md?raw";

export const Route = createFileRoute("/docs/deployment")({
  component: DeploymentComponent,
});

function DeploymentComponent() {
  return (
    <DocsLayout title="Deployment guide" activePath="/docs/deployment">
      <Markdown source={deploymentSource} />
    </DocsLayout>
  );
}
