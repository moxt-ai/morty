import { useAuth } from "@clerk/react";
import {
  MobiusChannelConnection,
  SlackAgentList,
} from "@moxt-ai/app-slack-web-core";
import type { ChannelConnection } from "@moxt-ai/mobius-web-core";
import { useState } from "react";

export function SlackManagement({
  connection,
}: {
  readonly connection: ChannelConnection | undefined;
}) {
  const { isLoaded, orgId } = useAuth();
  const [agentListGeneration, setAgentListGeneration] = useState(0);
  if (!isLoaded) {
    return <p role="status">Loading Slack integrations…</p>;
  }
  if (!orgId) {
    return (
      <p role="alert">Select this workspace to manage Slack integrations.</p>
    );
  }
  return (
    <div className="grid gap-4">
      <MobiusChannelConnection
        channel={connection}
        key={`channel-${orgId}`}
        onSelected={() => setAgentListGeneration((value) => value + 1)}
      />
      <SlackAgentList key={`agents-${orgId}-${agentListGeneration}`} />
    </div>
  );
}
