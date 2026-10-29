import { Archive, CircleAlert, FileText, Inbox, MessageSquare, PackageOpen, Plus, Unplug, WifiOff } from "lucide-react";
import { Tooltip } from "radix-ui";
import { type ComponentType, type ReactNode, useState } from "react";
import { AttemptFailure } from "../chat/attempt-failure.tsx";
import { ConnectionNotice } from "../chat/connection-notice.tsx";
import type { ConnectionFeedback, ExecutionContext } from "../chat/execution-context.ts";
import { ExecutionDetailsDialog } from "../chat/execution-details-dialog.tsx";
import { HarnessMark } from "../chat/harness-mark.tsx";
import { MessageBubble } from "../chat/message-bubble.tsx";
import { NativeSessionDirectoryPlaceholder } from "../chat/native-session-directory-placeholder.tsx";
import { SessionAgentTabs } from "../chat/session-agent-tabs.tsx";
import { ToolCallDisclosure } from "../chat/tools/tool-call-status.tsx";
import type { ToolCallState } from "../chat/tools/tool-renderer.ts";
import { UserMessageShell } from "../chat/user-message-shell.tsx";
import { WorkingIndicator } from "../chat/working-indicator.tsx";
import { AutoSelectInput } from "../ui/auto-select-input.tsx";
import { Button as FieldButton } from "../ui/button.tsx";
import { ButtonGroup } from "../ui/button-group.tsx";
import { Card } from "../ui/card.tsx";
import { Button } from "../ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../ui/copy-to-clipboard-button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import { LinkButton } from "../ui/link-button.tsx";
import { MortyAlert } from "../ui/morty-alert.tsx";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import { NavigationCardLink } from "../ui/navigation-card-link.tsx";
import { Select as OptionSelect } from "../ui/option-select.tsx";
import {
    executionDetailsDialogWidthPx,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "../ui/select.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { textLinkClassName } from "../ui/text-link.ts";
import { Textarea } from "../ui/textarea.tsx";
import { useToast } from "../ui/toast.tsx";
import type { PlaygroundEntryId } from "./catalog.ts";
import { COLOR_SECTIONS, type ColorToken } from "./color-tokens.ts";
import { Specimen } from "./specimen.tsx";

const typeSamples = [
    { className: "text-10", name: "text-10" },
    { className: "text-11", name: "text-11" },
    { className: "text-12", name: "text-12" },
    { className: "text-13", name: "text-13" },
    { className: "text-14", name: "text-14" },
    { className: "text-15", name: "text-15" },
    { className: "text-16", name: "text-16" },
    { className: "text-18", name: "text-18" },
    { className: "text-20", name: "text-20" },
    { className: "text-22", name: "text-22" },
    { className: "text-24", name: "text-24" },
    { className: "text-28", name: "text-28" },
    { className: "text-32", name: "text-32" },
] as const;

const radii = [
    { className: "rounded-xs", name: "xs" },
    { className: "rounded-sm", name: "sm" },
    { className: "rounded-md", name: "md" },
    { className: "rounded-lg", name: "lg" },
    { className: "rounded-xl", name: "xl" },
    { className: "rounded-2xl", name: "2xl" },
    { className: "rounded-3xl", name: "3xl" },
    { className: "rounded-4xl", name: "4xl" },
    { className: overlaySurfaceRadiusClassName, name: "overlay · 24px" },
] as const;

const cloudVariants = ["primary", "outline", "ghost", "destructive"] as const;
const cloudSizes = ["default", "lg", "sm", "xs", "icon"] as const;
const fieldVariants = ["default", "outline", "secondary", "ghost"] as const;
const fieldSizes = ["xs", "sm", "default", "lg", "icon"] as const;

const agentOptions = [
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude" },
    { label: "Pi", value: "pi" },
] as const;

const sessionAgents = [
    { agentRef: "codex", label: "Codex", value: "runtime:codex" },
    { agentRef: "claude-code", label: "Claude Code", value: "runtime:claude-code" },
    { agentRef: "pi", label: "Pi", value: "runtime:pi" },
] as const;

const toolStates = [
    { kind: "running" },
    { kind: "succeeded" },
    { kind: "failed" },
    { kind: "interrupted" },
    { kind: "unknown" },
] as const satisfies readonly ToolCallState[];

type CloudVariant = (typeof cloudVariants)[number];
type CloudSize = (typeof cloudSizes)[number];
type FieldVariant = (typeof fieldVariants)[number];
type FieldSize = (typeof fieldSizes)[number];
type DialogAppearance = "default" | "setup" | "surface" | "wide" | "busy";

function ChoiceRow<T extends string>({
    label,
    onChange,
    options,
    value,
}: {
    readonly label: string;
    readonly onChange: (value: T) => void;
    readonly options: readonly T[];
    readonly value: T;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-12 text-muted-foreground">{label}</span>
            {options.map((option) => (
                <Button
                    aria-pressed={option === value}
                    key={option}
                    onClick={() => onChange(option)}
                    size="sm"
                    variant={option === value ? "primary" : "outline"}
                >
                    {option}
                </Button>
            ))}
        </div>
    );
}

function ColorGallery() {
    return (
        <div className="grid gap-6">
            {COLOR_SECTIONS.map((section) => (
                <Specimen key={section.group} layout="stack" title={section.group}>
                    {section.tokens.map((token) => (
                        <ColorTokenRow key={token.variable} token={token} />
                    ))}
                </Specimen>
            ))}
        </div>
    );
}

/** Shows one variable's swatch, utility, name, and the value the document resolves it to. */
function ColorTokenRow({ token }: { readonly token: ColorToken }) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token.variable).trim();
    return (
        <div className="flex items-center gap-3">
            <div
                className="size-10 shrink-0 rounded-md border border-border"
                style={{ backgroundColor: `var(${token.variable})` }}
            />
            <dl className="grid min-w-0 gap-0.5">
                <dt className="font-mono text-12 font-medium">{token.utility}</dt>
                <dd className="font-mono text-11 break-all text-muted-foreground">
                    {[token.variable, value].filter((part) => part !== "").join(" · ")}
                </dd>
            </dl>
        </div>
    );
}

function TypeGallery() {
    return (
        <div className="grid gap-6">
            <Specimen layout="stack" title="Scale">
                {typeSamples.map((sample) => (
                    <p className={sample.className} key={sample.name}>
                        <span className="mr-3 font-mono text-12 text-muted-foreground">{sample.name}</span>
                        The agent is working
                    </p>
                ))}
            </Specimen>
            <Specimen layout="stack" title="Family and weight">
                <p className="font-sans text-16 font-normal">Sans regular</p>
                <p className="font-sans text-16 font-medium">Sans medium</p>
                <p className="font-sans text-16 font-semibold">Sans semibold</p>
                <p className="font-inter text-16">Inter</p>
                <p className="font-mono text-16">Roboto Mono 0123</p>
            </Specimen>
        </div>
    );
}

function RadiusGallery() {
    return (
        <div className="grid gap-6">
            <Specimen title="Radius">
                {radii.map((radius) => (
                    <div key={radius.name}>
                        <div className={`size-16 border border-border bg-primary-subtle ${radius.className}`} />
                        <p className="mt-2 text-center text-12 text-muted-foreground">{radius.name}</p>
                    </div>
                ))}
            </Specimen>
            <Specimen title="Module shadow">
                <div className="rounded-3xl bg-card px-6 py-5 shadow-module">
                    <p className="text-14 font-medium">Setup card</p>
                    <p className="mt-1 text-13 text-muted-foreground">shadow-module</p>
                </div>
            </Specimen>
        </div>
    );
}

function CloudButtonGallery() {
    const [variant, setVariant] = useState<CloudVariant>("primary");
    const [size, setSize] = useState<CloudSize>("default");
    const [disabled, setDisabled] = useState(false);
    return (
        <div className="grid gap-6">
            <Specimen layout="stack" title="Try it">
                <ChoiceRow label="Variant" onChange={setVariant} options={cloudVariants} value={variant} />
                <ChoiceRow label="Size" onChange={setSize} options={cloudSizes} value={size} />
                <Button onClick={() => setDisabled((current) => !current)} size="sm" variant="outline">
                    {disabled ? "Enable" : "Disable"}
                </Button>
                <Button
                    aria-label={size === "icon" ? "Add" : undefined}
                    disabled={disabled}
                    size={size}
                    variant={variant}
                >
                    {size === "icon" ? <Plus aria-hidden="true" className="size-4" /> : "Continue"}
                </Button>
            </Specimen>
            <Specimen layout="stack" title="All variants">
                {cloudVariants.map((item) => (
                    <div className="flex flex-wrap items-center gap-3" key={item}>
                        <span className="w-24 text-12 text-muted-foreground">{item}</span>
                        {cloudSizes.map((itemSize) => (
                            <Button
                                aria-label={itemSize === "icon" ? item : undefined}
                                key={itemSize}
                                size={itemSize}
                                variant={item}
                            >
                                {itemSize === "icon" ? <Plus aria-hidden="true" className="size-4" /> : itemSize}
                            </Button>
                        ))}
                        <Button disabled variant={item}>
                            Disabled
                        </Button>
                    </div>
                ))}
            </Specimen>
        </div>
    );
}

const buttonGroupSamples = [
    { gap: "12px", height: "40px", size: "lg" },
    { gap: "10px", height: "36px", size: "default" },
    { gap: "8px", height: "32px", size: "sm" },
    { gap: "6px", height: "28px", size: "xs" },
] as const;

function ButtonGroupGallery() {
    return (
        <div className="grid gap-6">
            <Specimen title="Stacked action pairs">
                {buttonGroupSamples.map((sample) => (
                    <div className="grid w-40 gap-2" key={sample.height}>
                        <div className="flex items-baseline justify-between text-12 text-muted-foreground">
                            <span>{sample.height}</span>
                            <span className="font-mono">{sample.gap}</span>
                        </div>
                        <ButtonGroup size={sample.size}>
                            <Button size={sample.size}>Try again</Button>
                            <Button size={sample.size} variant="outline">
                                Continue
                            </Button>
                        </ButtonGroup>
                    </div>
                ))}
            </Specimen>
            <Specimen layout="stack" title="Horizontal action pairs">
                {buttonGroupSamples.map((sample) => (
                    <div className="grid gap-2" key={sample.height}>
                        <p className="text-12 text-muted-foreground">
                            {sample.height} buttons · <span className="font-mono">{sample.gap}</span> gap
                        </p>
                        <ButtonGroup orientation="horizontal" size={sample.size}>
                            <Button size={sample.size}>Try again</Button>
                            <Button size={sample.size} variant="outline">
                                Continue
                            </Button>
                        </ButtonGroup>
                    </div>
                ))}
            </Specimen>
        </div>
    );
}

function FieldButtonGallery() {
    const [variant, setVariant] = useState<FieldVariant>("default");
    const [size, setSize] = useState<FieldSize>("default");
    return (
        <div className="grid gap-6">
            <Specimen layout="stack" title="Try it">
                <ChoiceRow label="Variant" onChange={setVariant} options={fieldVariants} value={variant} />
                <ChoiceRow label="Size" onChange={setSize} options={fieldSizes} value={size} />
                <FieldButton aria-label={size === "icon" ? "Add" : undefined} size={size} variant={variant}>
                    {size === "icon" ? <Plus aria-hidden="true" className="size-4" /> : "Approve"}
                </FieldButton>
            </Specimen>
            <Specimen layout="stack" title="All variants">
                {fieldVariants.map((item) => (
                    <div className="flex flex-wrap items-center gap-3" key={item}>
                        <span className="w-24 text-12 text-muted-foreground">{item}</span>
                        {fieldSizes.map((itemSize) => (
                            <FieldButton
                                aria-label={itemSize === "icon" ? item : undefined}
                                key={itemSize}
                                size={itemSize}
                                variant={item}
                            >
                                {itemSize === "icon" ? <Plus aria-hidden="true" className="size-4" /> : itemSize}
                            </FieldButton>
                        ))}
                    </div>
                ))}
            </Specimen>
        </div>
    );
}

function InputGallery() {
    const [value, setValue] = useState("morty");
    return (
        <Specimen layout="stack" title="States">
            <div className="grid max-w-sm gap-1.5">
                <label className="text-12 text-muted-foreground" htmlFor="playground-session-name">
                    Session name
                </label>
                <Input
                    id="playground-session-name"
                    onChange={(event) => setValue(event.currentTarget.value)}
                    value={value}
                />
            </div>
            <Input aria-label="Placeholder" className="max-w-sm" placeholder="Name this session" />
            <Input aria-label="Disabled field" className="max-w-sm" disabled value="Unavailable" />
        </Specimen>
    );
}

function TextareaGallery() {
    const [value, setValue] = useState("Ask the agent to tighten the button padding.");
    return (
        <Specimen layout="stack" title="Inside a composer surface">
            <div className="w-full max-w-lg rounded-[20px] border border-border bg-background px-3 py-2 transition-[border-color,box-shadow] has-[:focus]:border-[var(--color-ring)] has-[:focus]:shadow-[var(--focus-ring-shadow)]">
                <Textarea
                    aria-label="Message"
                    onChange={(event) => setValue(event.currentTarget.value)}
                    value={value}
                />
            </div>
            <div className="w-full max-w-lg rounded-[20px] border border-border bg-background px-3 py-2">
                <Textarea aria-label="Disabled message" disabled placeholder="Connect an agent to type" />
            </div>
        </Specimen>
    );
}

function AutoSelectInputGallery() {
    return (
        <Specimen layout="stack" title="Selects its text on mount">
            <AutoSelectInput
                aria-label="Rename session"
                className="h-9 max-w-sm rounded-md border border-border bg-background px-3 text-13 outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/20"
                defaultValue="Rename this session"
            />
        </Specimen>
    );
}

function OptionSelectGallery() {
    const [value, setValue] = useState("codex");
    return (
        <div className="grid gap-6">
            <Specimen title="Default">
                <div className="w-56">
                    <OptionSelect label="Agent" onValueChange={setValue} options={agentOptions} value={value} />
                </div>
            </Specimen>
            <Specimen title="Compact">
                <OptionSelect compact label="Model" onValueChange={setValue} options={agentOptions} value={value} />
            </Specimen>
            <Specimen title="Searchable">
                <div className="w-56">
                    <OptionSelect
                        label="Model"
                        onValueChange={setValue}
                        options={agentOptions}
                        searchable
                        value={value}
                    />
                </div>
            </Specimen>
            <Specimen title="Disabled">
                <div className="w-56">
                    <OptionSelect
                        disabled
                        label="Agent"
                        onValueChange={setValue}
                        options={agentOptions}
                        value={value}
                    />
                </div>
            </Specimen>
        </div>
    );
}

function MenuSelectGallery() {
    const [value, setValue] = useState("codex");
    return (
        <Specimen title="Grouped menu">
            <Select onValueChange={setValue} value={value}>
                <SelectTrigger aria-label="Agent">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        <SelectLabel>Agents</SelectLabel>
                        <SelectItem value="claude">Claude</SelectItem>
                        <SelectItem value="codex">Codex</SelectItem>
                        <SelectItem value="pi">Pi</SelectItem>
                    </SelectGroup>
                </SelectContent>
            </Select>
        </Specimen>
    );
}

function LinkButtonGallery() {
    const [followed, setFollowed] = useState(false);
    return (
        <Specimen title="In a sentence">
            <p className="text-14 text-foreground">
                Keep your computer online, or{" "}
                <LinkButton onClick={() => setFollowed(true)}>open the pairing steps</LinkButton>.
            </p>
            <p className="text-13 text-muted-foreground" role="status">
                {followed ? "Pairing steps opened in this preview." : "The link has not been used."}
            </p>
        </Specimen>
    );
}

function TextLinkGallery() {
    return (
        <Specimen layout="stack" title="In prose">
            <p className="text-14 text-foreground">
                Ask the owner in{" "}
                <a className={textLinkClassName} href="mailto:wuhuajia@paraflow.com">
                    wuhuajia@paraflow.com
                </a>{" "}
                before changing the timeout, then check{" "}
                <a className={textLinkClassName} href="https://moxt.ai/chat-replay">
                    the chat replay
                </a>
                .
            </p>
            <p className="text-13 text-muted-foreground">
                Resting is primary, hover is lighter, and pressed is darker. No underline in any state.
            </p>
        </Specimen>
    );
}

function SpinnerGallery() {
    return (
        <Specimen title="Announced status">
            <span className="inline-flex items-center gap-2 text-13 text-muted-foreground">
                <Spinner label="Loading sessions" />
                Loading sessions
            </span>
        </Specimen>
    );
}

function CardGallery() {
    return (
        <Specimen title="Grouped content">
            <Card className="max-w-sm p-4">
                <p className="text-14 font-semibold">Today</p>
                <p className="mt-1 text-13 text-muted-foreground">Sessions from this computer stay grouped here.</p>
            </Card>
        </Specimen>
    );
}

function AlertGallery() {
    return (
        <div className="grid max-w-xl gap-6">
            <Specimen layout="stack" title="Error">
                <MortyAlert>
                    The live session event stream could not recover. Cause: The live session event stream disconnected
                </MortyAlert>
                <MortyAlert description="Mobius is reconnecting…">
                    The live session event stream could not recover. Cause: The live session event stream disconnected
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Warning">
                <MortyAlert tone="warning">
                    This computer has been asleep. The agent may take a moment to respond.
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Success">
                <MortyAlert tone="success">Your computer is online and ready for a new session.</MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Info">
                <MortyAlert tone="info">
                    Messages stay on this computer. Morty only relays them while you are here.
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Neutral">
                <MortyAlert tone="neutral">Mobius is reconnecting…</MortyAlert>
            </Specimen>
        </div>
    );
}

/**
 * Every composer notice state on one page, built from the production
 * components. Unified rules: failures use the error tone, informational
 * connection states the neutral tone; line one carries the headline plus any
 * countdown and action inline, line two an optional muted detail that never
 * repeats the headline; a send failure combined with a connection status keeps
 * the connection as a single inline line under the headline.
 */
function ComposerNoticeGallery() {
    const noop = () => {};
    const retrying: ConnectionFeedback = {
        kind: "retrying",
        description: "Updates are paused. We’ll retry automatically. Your draft is saved.",
        remainingSeconds: 12,
        title: "Reconnecting…",
    };
    const failed: ConnectionFeedback = {
        kind: "failed",
        description: "You can keep writing. Retry to check the connection.",
        title: "Connection interrupted",
    };
    const waiting: ConnectionFeedback = {
        kind: "waiting",
        description: "You can keep writing while we connect.",
        title: "Connecting…",
    };
    const closed: ConnectionFeedback = {
        kind: "closed",
        description: "Continue where you left off.",
        reopen: "available",
    };
    return (
        <div className="grid max-w-xl gap-6">
            <Specimen layout="stack" title="Failure: runtime restarted mid-request">
                <MortyAlert>The local runtime restarted while this request was running</MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Failure: attachment rejected">
                <MortyAlert>Files must be between 1 byte and 32 MB.</MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Failure with connection status: inline line under the headline">
                <MortyAlert
                    description={<ConnectionNotice feedback={retrying} inline onRetryNow={noop} onReopen={noop} />}
                >
                    The message could not be sent.
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Failure: reconnect failed">
                <MortyAlert tone="error">
                    <ConnectionNotice feedback={failed} onRetryNow={noop} onReopen={noop} />
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Informational: connecting (compact chip on the chat surface)">
                <div className="rounded-xl bg-card p-4">
                    <ConnectionNotice feedback={waiting} onRetryNow={noop} onReopen={noop} />
                </div>
            </Specimen>
            <Specimen layout="stack" title="Informational: reconnecting">
                <MortyAlert icon={WifiOff} tone="neutral">
                    <ConnectionNotice feedback={retrying} onRetryNow={noop} onReopen={noop} />
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Informational: session closed">
                <MortyAlert icon={Archive} tone="neutral">
                    <ConnectionNotice feedback={closed} onRetryNow={noop} onReopen={noop} />
                </MortyAlert>
            </Specimen>
        </div>
    );
}

function NavigationCardGallery() {
    return (
        <Specimen title="Pending while the route loads">
            <NavigationCardLink
                className="inline-flex min-w-48 rounded-xl border border-border bg-card px-4 py-3 text-14 font-medium"
                label="Component library"
                to="/playground"
            >
                {(pending) => (pending ? "Opening library…" : "Component library")}
            </NavigationCardLink>
        </Specimen>
    );
}

const playgroundExecutionContext = {
    agent: "Codex",
    agentRef: "codex",
    available: true,
    computerStatus: "Online",
    connection: "Connected",
    directory: "/Users/jane/projects/morty",
    directoryName: "morty",
    directoryPlaceholder: "Working directory unavailable",
    feedback: { kind: "hidden" },
    indicator: { kind: "ready", label: "Ready" },
    lastConfirmed: "Last confirmed 2 min ago",
    machine: "Jane's MacBook",
} as const satisfies ExecutionContext;

function ExecutionDetailsDialogGallery() {
    const [open, setOpen] = useState(false);
    return (
        <Specimen title={`Desktop width ${executionDetailsDialogWidthPx}px`}>
            <Button onClick={() => setOpen(true)} variant="outline">
                Open execution details
            </Button>
            <ExecutionDetailsDialog
                context={playgroundExecutionContext}
                open={open}
                onOpenChange={setOpen}
                returnFocus={() => undefined}
            />
        </Specimen>
    );
}

function DialogGallery() {
    const [open, setOpen] = useState<DialogAppearance | null>(null);
    const appearance = open === "wide" || open === "busy" || open === null ? "default" : open;
    return (
        <Specimen title="Open one">
            <Button onClick={() => setOpen("default")} variant="outline">
                Default
            </Button>
            <Button onClick={() => setOpen("setup")} variant="outline">
                Setup
            </Button>
            <Button onClick={() => setOpen("surface")} variant="outline">
                Surface
            </Button>
            <Button onClick={() => setOpen("wide")} variant="outline">
                Wide
            </Button>
            <Button onClick={() => setOpen("busy")} variant="outline">
                Busy
            </Button>
            {open !== null && (
                <Dialog
                    appearance={appearance}
                    busy={open === "busy"}
                    description="This preview uses the real dialog. Close it to return to the library."
                    onClose={() => setOpen(null)}
                    title={open === "busy" ? "Saving session" : "Continue on this device"}
                    wide={open === "wide"}
                >
                    <p>
                        {open === "busy"
                            ? "Close stays disabled until the work finishes. Use the button below to finish it."
                            : "Approve requests and send instructions while the agent runs on your computer."}
                    </p>
                    {open === "busy" && (
                        <div className="mt-4 flex justify-end">
                            <Button onClick={() => setOpen(null)}>Finish</Button>
                        </div>
                    )}
                </Dialog>
            )}
        </Specimen>
    );
}

function PopoverGallery() {
    return (
        <Specimen title="Caller supplies padding, border, and shadow">
            <Popover.Root>
                <Popover.Trigger asChild>
                    <Button variant="outline">Open popover</Button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content
                        className={`z-50 w-64 border border-border bg-popover p-4 text-13 text-popover-foreground shadow-lg outline-none ${overlaySurfaceRadiusClassName}`}
                        sideOffset={overlayTriggerOffsetPx}
                    >
                        Anchored floating surfaces use {overlaySurfaceRadiusClassName} (24px).
                        <Popover.Arrow className="fill-popover" />
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
        </Specimen>
    );
}

function TooltipGallery() {
    return (
        <Specimen title="Hover or focus">
            <Tooltip.Provider delayDuration={200}>
                <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                        <Button variant="outline">Saved locally</Button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                        <MortyTooltipContent sideOffset={6}>Only this browser keeps the draft</MortyTooltipContent>
                    </Tooltip.Portal>
                </Tooltip.Root>
            </Tooltip.Provider>
        </Specimen>
    );
}

function ToastGallery() {
    const showToast = useToast();
    return (
        <Specimen title="Show a notification">
            <Button onClick={() => showToast({ title: "Session saved" })} variant="outline">
                Default
            </Button>
            <Button
                onClick={() => showToast({ description: "The command is on your clipboard.", title: "Copied" })}
                variant="outline"
            >
                With description
            </Button>
            <Button
                onClick={() =>
                    showToast({ description: "Try the copy again.", title: "Could not save", variant: "error" })
                }
                variant="outline"
            >
                Error
            </Button>
        </Specimen>
    );
}

function CopyButtonGallery() {
    return (
        <Specimen title="Copies and toasts">
            <code className="font-mono text-12">mobius bot approve --bot preview</code>
            <CopyToClipboardButton
                failureToast={{ description: "Select the command and copy it manually.", title: "Copy failed" }}
                label="Copy command"
                successToast={{ title: "Copied" }}
                value="mobius bot approve --bot preview"
            />
        </Specimen>
    );
}

function MessageGallery() {
    return (
        <Specimen layout="stack" title="Thread">
            <div className="grid w-full gap-6 py-2">
                <UserMessageShell>
                    <MessageBubble speaker="user">Check the button spacing on mobile.</MessageBubble>
                </UserMessageShell>
                <MessageBubble speaker="assistant">
                    The primary button uses a 13px label and a 36px minimum height.
                </MessageBubble>
            </div>
        </Specimen>
    );
}

function ToolCallGallery() {
    return (
        <Specimen layout="stack" title="States">
            <div className="grid gap-0">
                {toolStates.map((state) => (
                    <ToolCallDisclosure
                        ariaLabel={`Read styles.css, ${state.kind}`}
                        autoOpen={state.kind === "failed"}
                        icon={<FileText aria-hidden="true" />}
                        key={state.kind}
                        state={state}
                        title={`Read styles.css (${state.kind})`}
                    >
                        <p className="text-13 text-muted-foreground">packages/web/src/styles.css</p>
                    </ToolCallDisclosure>
                ))}
            </div>
        </Specimen>
    );
}

function WorkingIndicatorGallery() {
    const [startedAt] = useState(() => Date.now() - 75_000);
    return (
        <Specimen title="Elapsed">
            <WorkingIndicator startedAt={startedAt} />
        </Specimen>
    );
}

function NativeSessionDirectoryPlaceholderFrame({ children }: { readonly children: ReactNode }) {
    return (
        <div className="flex h-52 w-[15.75rem] max-w-full flex-col rounded-2xl border border-border bg-surface-subtle">
            {children}
        </div>
    );
}

function NativeSessionDirectoryPlaceholderGallery() {
    return (
        <div className="grid gap-6">
            <Specimen title="Preview empty">
                <NativeSessionDirectoryPlaceholderFrame>
                    <NativeSessionDirectoryPlaceholder
                        description="Preview its message history here."
                        icon={MessageSquare}
                        title="Select a session"
                    />
                </NativeSessionDirectoryPlaceholderFrame>
            </Specimen>
            <Specimen title="Agent not installed">
                <NativeSessionDirectoryPlaceholderFrame>
                    <NativeSessionDirectoryPlaceholder
                        description="Install it on this machine to browse saved sessions."
                        icon={PackageOpen}
                        title="Pi is not installed"
                    />
                </NativeSessionDirectoryPlaceholderFrame>
            </Specimen>
            <Specimen title="No runtime">
                <NativeSessionDirectoryPlaceholderFrame>
                    <NativeSessionDirectoryPlaceholder
                        description="Connect a runtime to browse saved sessions."
                        icon={Unplug}
                        title="No local agent"
                    />
                </NativeSessionDirectoryPlaceholderFrame>
            </Specimen>
            <Specimen title="Empty directory">
                <NativeSessionDirectoryPlaceholderFrame>
                    <NativeSessionDirectoryPlaceholder
                        description="This agent didn't report any on this machine."
                        icon={Inbox}
                        title="No saved sessions"
                    />
                </NativeSessionDirectoryPlaceholderFrame>
            </Specimen>
            <Specimen title="Load failed">
                <NativeSessionDirectoryPlaceholderFrame>
                    <NativeSessionDirectoryPlaceholder
                        description="The local agent operation could not be completed."
                        icon={CircleAlert}
                        title="Couldn't load sessions"
                        tone="destructive"
                    />
                </NativeSessionDirectoryPlaceholderFrame>
            </Specimen>
        </div>
    );
}

function SessionAgentTabsGallery() {
    const [disabled, setDisabled] = useState(false);
    const [value, setValue] = useState("runtime:codex");
    const selected = sessionAgents.find((agent) => agent.value === value);
    return (
        <Specimen layout="stack" title="Try it">
            <Button onClick={() => setDisabled((current) => !current)} size="sm" variant="outline">
                {disabled ? "Enable" : "Disable"}
            </Button>
            <div className="w-[15.75rem] max-w-full">
                <SessionAgentTabs agents={sessionAgents} disabled={disabled} onValueChange={setValue} value={value} />
            </div>
            <p className="text-12 text-muted-foreground" role="status">
                Selected: {selected?.label ?? "None"}
            </p>
        </Specimen>
    );
}

function HarnessMarkGallery() {
    const marks = [
        { agentRef: "claude", label: "Claude" },
        { agentRef: "codex", label: "Codex" },
        { agentRef: "pi", label: "Pi" },
        { agentRef: "local", label: "Local agent" },
    ] as const;
    return (
        <>
            <Specimen title="Products">
                {marks.map((mark) => (
                    <span className="inline-flex items-center gap-2 text-13" key={mark.agentRef}>
                        <HarnessMark
                            agentRef={mark.agentRef}
                            label={mark.label}
                            testId={`playground-harness-${mark.agentRef}`}
                        />
                        {mark.label}
                    </span>
                ))}
            </Specimen>
            <Specimen title="Waiting for the agent">
                <span className="inline-flex items-center gap-2 text-13">
                    <HarnessMark agentRef="pi" appearance="line" label="Pi" loading />
                    Line mark, still unknown
                </span>
                <span className="inline-flex items-center gap-2 text-13">
                    <HarnessMark agentRef="pi" label="Pi" loading />
                    Badge mark, still unknown
                </span>
            </Specimen>
        </>
    );
}

function AttemptFailureGallery() {
    return (
        <div className="grid gap-6">
            <Specimen title="Message only">
                <div className="w-full">
                    <AttemptFailure
                        approval={{ kind: "unavailable" }}
                        code="agent_unavailable"
                        message="The agent stopped before it could answer."
                    />
                </div>
            </Specimen>
            <Specimen title="Needs approval">
                <div className="w-full">
                    <AttemptFailure
                        approval={{ botId: "preview-bot", kind: "bot-approval" }}
                        code="binding_not_approved"
                        message="This browser is not approved to talk to the agent yet."
                    />
                </div>
            </Specimen>
        </div>
    );
}

const galleries = {
    alert: AlertGallery,
    "attempt-failure": AttemptFailureGallery,
    "auto-select-input": AutoSelectInputGallery,
    button: FieldButtonGallery,
    "button-group": ButtonGroupGallery,
    card: CardGallery,
    "cloud-button": CloudButtonGallery,
    color: ColorGallery,
    "composer-notice": ComposerNoticeGallery,
    "copy-button": CopyButtonGallery,
    dialog: DialogGallery,
    "execution-details-dialog": ExecutionDetailsDialogGallery,
    "harness-mark": HarnessMarkGallery,
    input: InputGallery,
    "link-button": LinkButtonGallery,
    "menu-select": MenuSelectGallery,
    message: MessageGallery,
    "native-session-directory-placeholder": NativeSessionDirectoryPlaceholderGallery,
    "navigation-card": NavigationCardGallery,
    "option-select": OptionSelectGallery,
    popover: PopoverGallery,
    radius: RadiusGallery,
    "session-agent-tabs": SessionAgentTabsGallery,
    spinner: SpinnerGallery,
    "text-link": TextLinkGallery,
    textarea: TextareaGallery,
    toast: ToastGallery,
    "tool-call": ToolCallGallery,
    tooltip: TooltipGallery,
    type: TypeGallery,
    "working-indicator": WorkingIndicatorGallery,
} satisfies Record<PlaygroundEntryId, ComponentType>;

export function PlaygroundGallery({ id }: { readonly id: PlaygroundEntryId }) {
    const Gallery = galleries[id];
    return <Gallery />;
}
