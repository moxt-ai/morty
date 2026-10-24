import { useStore } from "zustand";
import { ComputerMenu } from "../../components/chat/computer-menu.tsx";
import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import { botConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import type { ComputerSwitcherModel } from "../../view-models/chat/computer-switcher-store.ts";
import { pendingExecutionContext, sessionExecutionContext } from "../../view-models/chat/execution-context.ts";

function ComputerSwitcher({
    model,
    context,
    workspace,
    compact,
}: {
    readonly model: ComputerSwitcherModel;
    readonly context: ExecutionContext;
    readonly workspace: ChatWorkspace;
    readonly compact: boolean;
}) {
    const state = useStore(model.store);
    const home = useStore(workspace.home);
    return (
        <ComputerMenu
            choices={state.choices}
            loading={state.kind === "loading"}
            activeKey={model.activeKey}
            name={home.runtimeConfiguration?.runtime.machineName ?? ""}
            status={botConnectionStatus(home)}
            context={context}
            compact={compact}
            onOpen={() => {
                void model.refresh();
            }}
        />
    );
}

export function WorkspaceComputerSwitcher({
    workspace,
    compact,
}: {
    readonly workspace: ChatWorkspace;
    readonly compact: boolean;
}) {
    const home = useStore(workspace.home);
    const draft = useStore(workspace.draftControls);
    const model = workspace.computers;
    const pane = workspace.sessionPane();
    const source = useStore(pane?.store ?? workspace.home);
    const context =
        home.selection.kind === "ready" && pane !== null && "connection" in source
            ? sessionExecutionContext(pane.session, home, source.connection)
            : pendingExecutionContext(home, draft.settings);
    if (model === null) {
        return null;
    }
    return <ComputerSwitcher workspace={workspace} model={model} compact={compact} context={context} />;
}

export function OnlineComputerAlternative({ model }: { readonly model: ComputerSwitcherModel }) {
    const { choices } = useStore(model.store);
    const alternative = choices.find((choice) => choice.key !== model.activeKey && choice.status === "online");
    return alternative === undefined ? null : (
        <a className="mt-2 inline-flex text-xs font-medium text-primary underline" href={alternative.href}>
            Switch to {alternative.name}
        </a>
    );
}
