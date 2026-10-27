import { Tabs } from "radix-ui";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { HarnessMark } from "./harness-mark.tsx";

const sessionAgentTabsListClassName = "flex h-9 min-w-0 gap-0.5 rounded-full bg-morty-fill-opacity-2 p-0.5";

/** Icon-only tab footprint; keep in sync with `SessionAgentTabs` loading skeleton. */
const sessionAgentTabInactiveLayoutClassName =
    "box-border flex h-full w-14 min-w-0 shrink-0 grow-0 items-center justify-center px-1.5 sm:w-10";

const sessionAgentTabTriggerClassName = cn(
    "group relative gap-1.5 rounded-full border border-transparent text-[13px] text-copy-secondary outline-none transition-[flex-grow,background-color,color,border-color] duration-200 hover:text-foreground keyboard-focus:focus-visible:ring-2 keyboard-focus:focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:hover:bg-transparent data-[state=inactive]:hover:bg-morty-fill-opacity-3 data-[state=active]:border-white data-[state=active]:bg-card data-[state=active]:font-medium data-[state=active]:text-foreground motion-reduce:transition-none",
    sessionAgentTabInactiveLayoutClassName,
    "data-[state=active]:min-w-0 data-[state=active]:flex-1 data-[state=active]:shrink data-[state=active]:grow data-[state=active]:px-2.5",
);

export function SessionAgentTabs({
    agents,
    className,
    dimInactive = true,
    disabled,
    onValueChange,
    value,
}: {
    readonly agents: readonly {
        readonly agentRef: string;
        readonly installed?: boolean;
        readonly label: string;
        readonly runtimeId: string;
    }[];
    readonly className?: string;
    /** When false, inactive tabs stay at full opacity (e.g. while the directory is refreshing). */
    readonly dimInactive?: boolean;
    readonly disabled: boolean;
    readonly onValueChange: (value: string) => void;
    readonly value: string;
}) {
    return (
        <Tabs.Root className={className} onValueChange={onValueChange} value={value}>
            <Tabs.List aria-label="Session agent" className={sessionAgentTabsListClassName}>
                {agents.map((agent) => {
                    const optionValue = `${agent.runtimeId}:${agent.agentRef}`;
                    const installed = agent.installed !== false;
                    return (
                        <Tabs.Trigger
                            className={cn(
                                sessionAgentTabTriggerClassName,
                                dimInactive &&
                                    "disabled:opacity-50 data-[state=inactive]:opacity-60 data-[state=inactive][data-installed=false]:opacity-45",
                            )}
                            data-installed={installed ? "true" : "false"}
                            disabled={disabled}
                            key={optionValue}
                            title={installed ? agent.label : `${agent.label} (not installed)`}
                            value={optionValue}
                        >
                            <HarnessMark
                                agentRef={agent.agentRef}
                                appearance="line"
                                label={agent.label}
                                testId={dataTestId.harnessMark}
                            />
                            <span className="min-w-0 truncate group-data-[state=inactive]:sr-only">{agent.label}</span>
                        </Tabs.Trigger>
                    );
                })}
            </Tabs.List>
        </Tabs.Root>
    );
}
