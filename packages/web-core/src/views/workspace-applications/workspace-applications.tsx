import { type ComponentType, useState } from "react";
import type { WorkspaceConnectionProps } from "../../view-models/workspaces/connections.ts";

export interface PairApplicationProps<TConnection> {
  readonly onConnected: (connection: TConnection) => void;
}

export interface ChatApplicationProps<TConnection> {
  readonly connection: TConnection;
}

export interface SlackApplicationProps<TConnection> {
  readonly connection: TConnection | undefined;
}

type WorkspaceApplicationState<TConnection> =
  | { readonly kind: "unpaired"; readonly selected: "pair" | "slack" }
  | {
      readonly kind: "connected";
      readonly connection: TConnection;
      readonly selected: "pair" | "chat" | "slack";
    };

const tabClass =
  "border-b-2 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";

export function WorkspaceApplications<TConnection>({
  ChatApplication,
  PairApplication,
  SlackApplication,
  initialConnection,
  onConnected,
}: WorkspaceConnectionProps<TConnection> & {
  readonly ChatApplication: ComponentType<ChatApplicationProps<TConnection>>;
  readonly PairApplication: ComponentType<PairApplicationProps<TConnection>>;
  readonly SlackApplication: ComponentType<SlackApplicationProps<TConnection>>;
}) {
  const [state, setState] = useState<WorkspaceApplicationState<TConnection>>(
    () =>
      initialConnection.kind === "connected"
        ? { ...initialConnection, selected: "chat" }
        : { kind: "unpaired", selected: "pair" },
  );
  const [failure, setFailure] = useState<string | null>(null);
  const select = (selected: "pair" | "chat" | "slack"): void => {
    setState((current) => {
      if (current.kind === "unpaired") {
        return selected === "chat" ? current : { ...current, selected };
      }
      return { ...current, selected };
    });
  };

  return (
    <>
      {failure !== null && <p role="alert">{failure}</p>}
      <div
        aria-label="Workspace applications"
        className="border-b border-zinc-200"
        role="tablist"
      >
        <button
          aria-selected={state.selected === "pair"}
          className={`${tabClass} ${state.selected === "pair" ? "border-violet-700 text-violet-700" : "border-transparent text-zinc-500"}`}
          onClick={() => select("pair")}
          role="tab"
          type="button"
        >
          Pair
        </button>
        <button
          aria-selected={state.selected === "chat"}
          className={`${tabClass} ${state.selected === "chat" ? "border-violet-700 text-violet-700" : "border-transparent text-zinc-500"}`}
          disabled={state.kind === "unpaired"}
          onClick={() => select("chat")}
          role="tab"
          type="button"
        >
          Chat
        </button>
        <button
          aria-selected={state.selected === "slack"}
          className={`${tabClass} ${state.selected === "slack" ? "border-violet-700 text-violet-700" : "border-transparent text-zinc-500"}`}
          onClick={() => select("slack")}
          role="tab"
          type="button"
        >
          Slack
        </button>
      </div>
      <section
        aria-label={
          state.selected === "pair"
            ? "Pair"
            : state.selected === "chat"
              ? "Chat"
              : "Slack"
        }
        className="mt-6 min-h-80 rounded-2xl border border-zinc-200 bg-white p-6"
        role="tabpanel"
      >
        {state.selected === "pair" && (
          <PairApplication
            onConnected={(connection) => {
              try {
                onConnected(connection);
                setFailure(null);
                setState({ kind: "connected", connection, selected: "chat" });
              } catch {
                setFailure(
                  "This browser could not save the machine connection. Allow site storage and try again.",
                );
              }
            }}
          />
        )}
        {state.kind === "connected" && state.selected === "chat" && (
          <ChatApplication connection={state.connection} />
        )}
        {state.selected === "slack" && (
          <SlackApplication
            connection={
              state.kind === "connected" ? state.connection : undefined
            }
          />
        )}
      </section>
    </>
  );
}
