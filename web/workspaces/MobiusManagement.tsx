import { MobiusSlackContext } from "@moxt-ai/app-slack-web-core";
import {
  type ChannelConnection,
  MobiusChat,
  Pair,
} from "@moxt-ai/mobius-web-core";
import { SlackManagement } from "./SlackManagement.tsx";
import {
  type ChatApplicationProps,
  type PairApplicationProps,
  type SlackApplicationProps,
  WorkspaceApplications,
} from "./WorkspaceApplications.tsx";

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

export function MobiusManagement() {
  return (
    <MobiusSlackContext context={{ mobiusUrl: window.location.origin }}>
      <WorkspaceApplications
        ChatApplication={ChatApplication}
        PairApplication={PairApplication}
        SlackApplication={SlackApplication}
      />
    </MobiusSlackContext>
  );
}
