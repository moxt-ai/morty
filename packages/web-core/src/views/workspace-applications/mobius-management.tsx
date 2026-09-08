import { MobiusSlackContext } from "@moxt-ai/app-slack-web-core";
import {
  type ChannelConnection,
  MobiusChat,
  Pair,
  readChannelConnection,
} from "@moxt-ai/mobius-web-core";
import {
  BrowserWorkspaceConnections,
  type WorkspaceConnectionProps,
} from "../../view-models/workspaces/connections.ts";
import { SlackManagement } from "./slack-management.tsx";
import {
  type ChatApplicationProps,
  type PairApplicationProps,
  type SlackApplicationProps,
  WorkspaceApplications,
} from "./workspace-applications.tsx";

function PairApplication({
  onConnected,
}: PairApplicationProps<ChannelConnection>) {
  return <Pair onConnected={onConnected} />;
}

function ChatApplication({
  connection,
}: ChatApplicationProps<ChannelConnection>) {
  return <MobiusChat connection={connection} />;
}

function SlackApplication({
  connection,
}: SlackApplicationProps<ChannelConnection>) {
  return <SlackManagement connection={connection} />;
}

export function mobiusWorkspaceConnections(userId: string) {
  return new BrowserWorkspaceConnections(
    userId,
    window.localStorage,
    readChannelConnection,
  );
}

export function MobiusManagement(
  props: WorkspaceConnectionProps<ChannelConnection>,
) {
  return (
    <MobiusSlackContext context={{ mobiusUrl: window.location.origin }}>
      <WorkspaceApplications
        {...props}
        ChatApplication={ChatApplication}
        PairApplication={PairApplication}
        SlackApplication={SlackApplication}
      />
    </MobiusSlackContext>
  );
}
