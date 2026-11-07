import type { SessionElicitationField } from "@morty-build/client";
import {
    ChevronRight,
    CircleAlert,
    FileText,
    Inbox,
    Laptop,
    Link,
    MessageSquare,
    PackageOpen,
    Plus,
    Unplug,
} from "lucide-react";
import { Tooltip } from "radix-ui";
import { type ComponentType, type ReactNode, useState } from "react";
import type { ElicitationFieldValue } from "@/services/chat/elicitation-form";
import { AttemptFailure } from "../chat/attempt-failure.tsx";
import { ConnectionNotice } from "../chat/connection-notice.tsx";
import { DeviceSummary } from "../chat/device-list.tsx";
import type { ConnectionFeedback, ExecutionContext } from "../chat/execution-context.ts";
import { ExecutionDetailsDialog } from "../chat/execution-details-dialog.tsx";
import { HarnessMark } from "../chat/harness-mark.tsx";
import { MessageBubble } from "../chat/message-bubble.tsx";
import { NativeSessionDirectoryPlaceholder } from "../chat/native-session-directory-placeholder.tsx";
import { SessionAgentTabs } from "../chat/session-agent-tabs.tsx";
import {
    type ElicitationInteraction,
    type PermissionFileChange,
    type PermissionInteraction,
    SessionInteractionCards,
} from "../chat/session-interactions.tsx";
import { ToolCallDisclosure } from "../chat/tools/tool-call-status.tsx";
import type { ToolCallState } from "../chat/tools/tool-renderer.ts";
import { UserMessageShell } from "../chat/user-message-shell.tsx";
import { WorkingIndicator } from "../chat/working-indicator.tsx";
import { SetupPromptDetails } from "../setup/setup-prompt-guidance.tsx";
import { AutoSelectInput } from "../ui/auto-select-input.tsx";
import { ButtonGroup } from "../ui/button-group.tsx";
import { Card } from "../ui/card.tsx";
import { Button } from "../ui/cloud-button.tsx";
import { CopyToClipboardButton } from "../ui/copy-to-clipboard-button.tsx";
import {
    Dialog,
    type DialogVariant,
    dialogBodyStackClassName,
    dialogPinnedFooterActionsClassName,
    dialogSectionTitleClassName,
    dialogSurfaceBodyClassName,
    dialogVariantCatalog,
} from "../ui/dialog.tsx";
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
    overlayWidthLadder,
    overlayWidthPx,
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
import { darkTextLinkClassName, mutedTextLinkClassName, textLinkClassName } from "../ui/text-link.ts";
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

const cloudVariants = ["primary", "outline", "secondary", "ghost", "destructive"] as const;
const cloudSizes = ["xs", "sm", "default", "lg", "icon"] as const;
/** Smallest to largest; used where specimens show every text size in one row. */
const textButtonSizes = ["xs", "sm", "default", "lg"] as const;
/** Added beside the pill xs. Text edges are 8px; an icon edge is 6px; radius is 10px. */
const xsSmallRadiusClassName = "rounded-[10px] pl-2 pr-2";
const xsSmallRadiusLeadingClassName = "rounded-[10px] pl-1.5 pr-2";
const xsSmallRadiusTrailingClassName = "rounded-[10px] pl-2 pr-1.5";

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
type DialogGalleryOpen =
    | "reference"
    | "confirm"
    | "form"
    | "scroll"
    | "default"
    | "setup"
    | "surface"
    | "busy"
    | "medium"
    | "large"
    | "wide";

const dialogGalleryVariantDescription: Readonly<Partial<Record<DialogVariant, ReactNode>>> = {
    bugReport:
        "Send a description, optional images and recent technical and network diagnostics to the Morty team. Session text, other files and credentials are not collected automatically.",
    connectAgentPairing: "Morty is ready. Paste this instruction into your local agent to connect it.",
    devicesAccess: "Who can use your computer from Morty, and for how long.",
    endAccess: (
        <>
            <span className="block">
                This browser loses access to your computer. Your computer and your other devices keep theirs, and links
                you already shared still work until they expire.
            </span>
            <span className="mt-3 block font-medium text-foreground">Your local agent and tasks keep running.</span>
        </>
    ),
    identitySharing: "Scan the code or open the link on the device you want to use.",
    networkLatency: "Round-trip latency for this browser and its connected Runtime.",
    openSession: "Import a native agent session into Morty Chat.",
    workingDirectory: "Pick the folder the agent should use as its working directory.",
};

function DialogGalleryReferenceBody() {
    return (
        <div className={dialogBodyStackClassName}>
            <MortyAlert tone="warning">
                Anyone who opens this link can view and control every session on this computer.
            </MortyAlert>
            <div className="grid gap-2">
                <p className={dialogSectionTitleClassName}>Device access</p>
                <p className="text-13 leading-5 text-muted-foreground">
                    Dialog-level warnings use <code className="text-12">MortyAlert</code>; neutral instructions stay in{" "}
                    <code className="text-12">description</code>.
                </p>
            </div>
        </div>
    );
}

function DialogGalleryReferenceFooter({ onClose }: { readonly onClose: () => void }) {
    return (
        <div className={dialogPinnedFooterActionsClassName}>
            <Button onClick={onClose} variant="ghost">
                Cancel
            </Button>
            <Button variant="primary">Continue</Button>
        </div>
    );
}

const dialogGalleryDeviceGroupCardClassName =
    "overflow-hidden rounded-[20px] border border-white bg-card px-4 shadow-module";

/** Playground-only: device groups. The group disconnect sits on the shared-links heading. */
const dialogGalleryDevicesAccessBodyClassName = "space-y-5 px-0";

function DialogGalleryDevicesAccessBody() {
    return (
        <div className={dialogGalleryDevicesAccessBodyClassName}>
            <ul aria-label="Devices with access" className="space-y-5">
                <li className="space-y-1.5">
                    <h3 className={dialogSectionTitleClassName}>Always here</h3>
                    <div className={dialogGalleryDeviceGroupCardClassName}>
                        <div className="py-3">
                            <DeviceSummary
                                device={{
                                    name: "This browser",
                                    details: [{ kind: "fields", fields: [{ label: "Until", value: "Nov 12, 2026" }] }],
                                }}
                            />
                        </div>
                        <div className="border-t border-border/40 -mx-4 px-4 py-3">
                            <DeviceSummary
                                device={{
                                    name: "Your computer",
                                    details: [{ kind: "text", text: "Always keeps access · can disconnect all" }],
                                }}
                                icon={Laptop}
                            />
                        </div>
                    </div>
                </li>
                <li className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className={dialogSectionTitleClassName}>Shared from links</h3>
                        <LinkButton className={`shrink-0 ${mutedTextLinkClassName}`}>Disconnect all</LinkButton>
                    </div>
                    <div className={dialogGalleryDeviceGroupCardClassName}>
                        <p className="py-3 text-13 text-morty-text-3">No other device has access.</p>
                    </div>
                </li>
            </ul>
        </div>
    );
}

const dialogGallerySetupPrompt = "Run setup on the computer where your agent lives, then return here with the link.";

/** Static pairing layout for the library; production uses the view wired to live handoff state. */
function DialogGalleryPairingBody({ actionPresentation }: { readonly actionPresentation: "setup-card" | "dialog" }) {
    const isDialog = actionPresentation === "dialog";
    const hintClassName = isDialog
        ? "mt-3 min-h-10 text-center text-13 leading-5 text-muted-foreground"
        : "mt-3 min-h-10 text-center text-sm leading-5 text-morty-text-2";
    return (
        <div>
            <CopyToClipboardButton
                className={isDialog ? "w-full" : "w-full rounded-xl"}
                failureToast={{
                    description: "Copy this page's address from your browser instead.",
                    title: "Could not copy",
                }}
                label="Copy link"
                size={isDialog ? "default" : "lg"}
                value="https://morty.example/"
            >
                <Link aria-hidden="true" className="size-4" />
                <span>Copy link</span>
            </CopyToClipboardButton>
            <p className={hintClassName}>Setup runs on your computer. Open Morty there to copy the prompt.</p>
            <SetupPromptDetails prompt={dialogGallerySetupPrompt} />
        </div>
    );
}

function DialogGalleryConfirmFooter({ onClose }: { readonly onClose: () => void }) {
    return (
        <div className={dialogPinnedFooterActionsClassName}>
            <Button onClick={onClose} variant="ghost">
                Cancel
            </Button>
            <Button onClick={onClose} variant="destructive">
                Delete
            </Button>
        </div>
    );
}

const dialogGalleryFormId = "dialog-gallery-session-form";

function DialogGalleryFormFooter({ onClose }: { readonly onClose: () => void }) {
    return (
        <div className={dialogPinnedFooterActionsClassName}>
            <Button onClick={onClose} type="button" variant="ghost">
                Cancel
            </Button>
            <Button form={dialogGalleryFormId} type="submit" variant="primary">
                Save
            </Button>
        </div>
    );
}

function DialogGalleryFormBody({ onClose }: { readonly onClose: () => void }) {
    return (
        <form
            className={dialogBodyStackClassName}
            id={dialogGalleryFormId}
            onSubmit={(event) => {
                event.preventDefault();
                onClose();
            }}
        >
            <label className="grid gap-2 pb-1" htmlFor="dialog-gallery-session-name">
                <span className={dialogSectionTitleClassName}>Name</span>
                <Input id="dialog-gallery-session-name" name="name" placeholder="Session name" required />
            </label>
            <label className="grid gap-2 pb-1" htmlFor="dialog-gallery-session-note">
                <span className={dialogSectionTitleClassName}>Note</span>
                <Input id="dialog-gallery-session-note" name="note" placeholder="Optional" />
            </label>
        </form>
    );
}

const dialogGalleryScrollItems = [
    "Renamed the session",
    "Changed the working directory",
    "Switched the agent to Codex",
    "Updated the model",
    "Paused after a permission request",
    "Attached three screenshots",
    "Shared a continue link",
    "Opened the session on another browser",
    "Measured network latency",
    "Disconnected a shared device",
    "Imported a native session",
    "Sent a bug report",
] as const;

function DialogGalleryScrollFooter({ onClose }: { readonly onClose: () => void }) {
    return (
        <div className={dialogPinnedFooterActionsClassName}>
            <Button onClick={onClose} variant="ghost">
                Cancel
            </Button>
            <Button onClick={onClose} variant="primary">
                Done
            </Button>
        </div>
    );
}

function DialogGalleryScrollBody() {
    return (
        <ul className="divide-y divide-border rounded-lg border border-border">
            {dialogGalleryScrollItems.map((item) => (
                <li key={item} className="px-4 py-3">
                    {item}
                </li>
            ))}
        </ul>
    );
}

function DialogGalleryPlaceholderBody() {
    return (
        <div className={dialogBodyStackClassName}>
            <p className="text-13 leading-5 text-muted-foreground">Body content for this product variant.</p>
        </div>
    );
}

function DialogGalleryPlaceholderFooter({ onClose }: { readonly onClose: () => void }) {
    return (
        <div className={dialogPinnedFooterActionsClassName}>
            <Button onClick={onClose} variant="ghost">
                Close
            </Button>
        </div>
    );
}

function dialogGalleryBodyForVariant(variant: DialogVariant): ReactNode {
    switch (variant) {
        case "identitySharing":
            return <DialogGalleryReferenceBody />;
        case "devicesAccess":
            return <DialogGalleryDevicesAccessBody />;
        case "connectAgentPairing":
            return <DialogGalleryPairingBody actionPresentation="dialog" />;
        default:
            return <DialogGalleryPlaceholderBody />;
    }
}

function dialogGalleryShellFooter(open: DialogGalleryOpen, onClose: () => void): ReactNode {
    switch (open) {
        case "scroll":
            return <DialogGalleryScrollFooter onClose={onClose} />;
        case "form":
            return <DialogGalleryFormFooter onClose={onClose} />;
        case "confirm":
            return <DialogGalleryConfirmFooter onClose={onClose} />;
        case "reference":
            return <DialogGalleryReferenceFooter onClose={onClose} />;
        case "busy":
            return (
                <div className={dialogPinnedFooterActionsClassName}>
                    <Button onClick={onClose} variant="primary">
                        Finish
                    </Button>
                </div>
            );
        case "default":
        case "medium":
        case "large":
        case "wide":
            return <DialogGalleryPlaceholderFooter onClose={onClose} />;
        case "setup":
        case "surface":
            return undefined;
    }
}

function dialogGalleryFooterForVariant(variant: DialogVariant, onClose: () => void): ReactNode {
    switch (variant) {
        case "identitySharing":
            return <DialogGalleryReferenceFooter onClose={onClose} />;
        case "devicesAccess":
        case "connectAgentPairing":
        case "openSession":
            return undefined;
        default:
            return <DialogGalleryPlaceholderFooter onClose={onClose} />;
    }
}

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
                className="size-10 shrink-0 rounded-sm border border-border"
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
    const [textButtonUsed, setTextButtonUsed] = useState(false);
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
                    {size === "icon" ? <Plus aria-hidden="true" /> : "Continue"}
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
                                {itemSize === "icon" ? <Plus aria-hidden="true" /> : itemSize}
                            </Button>
                        ))}
                        <Button disabled variant={item}>
                            Disabled
                        </Button>
                    </div>
                ))}
            </Specimen>
            <Specimen layout="stack" title="Leading and trailing icons">
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Leading</span>
                    {textButtonSizes.map((itemSize) => (
                        <Button key={itemSize} size={itemSize}>
                            <Plus aria-hidden="true" />
                            Continue
                        </Button>
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Trailing</span>
                    {textButtonSizes.map((itemSize) => (
                        <Button key={itemSize} size={itemSize}>
                            Continue
                            <ChevronRight aria-hidden="true" />
                        </Button>
                    ))}
                </div>
            </Specimen>
            <Specimen layout="stack" title="xs · 10px radius">
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Text</span>
                    {cloudVariants.map((item) => (
                        <Button className={xsSmallRadiusClassName} key={item} size="xs" variant={item}>
                            {item}
                        </Button>
                    ))}
                    <Button className={xsSmallRadiusClassName} disabled size="xs">
                        Disabled
                    </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Leading</span>
                    <Button className={xsSmallRadiusLeadingClassName} size="xs">
                        <Plus aria-hidden="true" />
                        Continue
                    </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Trailing</span>
                    <Button className={xsSmallRadiusTrailingClassName} size="xs">
                        Continue
                        <ChevronRight aria-hidden="true" />
                    </Button>
                </div>
            </Specimen>
            <Specimen layout="stack" title="Text button">
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Default</span>
                    <LinkButton onClick={() => setTextButtonUsed(true)}>Retry now</LinkButton>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Gray</span>
                    <LinkButton className={mutedTextLinkClassName} onClick={() => setTextButtonUsed(true)}>
                        Switch computer
                    </LinkButton>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Dark</span>
                    <LinkButton className={darkTextLinkClassName} onClick={() => setTextButtonUsed(true)}>
                        Switch computer
                    </LinkButton>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <span className="w-24 text-12 text-muted-foreground">Disabled</span>
                    <LinkButton disabled>Reopen it</LinkButton>
                </div>
                <p className="text-14 text-foreground">
                    Keep your computer online, or{" "}
                    <LinkButton onClick={() => setTextButtonUsed(true)}>open the pairing steps</LinkButton>. You can
                    also{" "}
                    <LinkButton className={mutedTextLinkClassName} onClick={() => setTextButtonUsed(true)}>
                        switch computer
                    </LinkButton>{" "}
                    or{" "}
                    <LinkButton className={darkTextLinkClassName} onClick={() => setTextButtonUsed(true)}>
                        use another computer
                    </LinkButton>
                    .
                </p>
                <p className="text-13 text-muted-foreground" role="status">
                    {textButtonUsed ? "Text button used in this preview." : "The text button has not been used."}
                </p>
            </Specimen>
            <Specimen layout="stack" title="Text link">
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
                <p className="text-14 text-foreground">
                    The session stays on this computer.{" "}
                    <a className={mutedTextLinkClassName} href="#status">
                        View the status note
                    </a>{" "}
                    or{" "}
                    <a className={mutedTextLinkClassName} href="#logs">
                        open local logs
                    </a>
                    .
                </p>
                <p className="text-14 text-foreground">
                    The notes stay on this computer.{" "}
                    <a className={darkTextLinkClassName} href="#status">
                        View the status note
                    </a>{" "}
                    or{" "}
                    <a className={darkTextLinkClassName} href="#logs">
                        open local logs
                    </a>
                    .
                </p>
                <p className="text-13 text-muted-foreground">
                    Resting is primary, hover is lighter, and pressed is darker. Gray rests as secondary text and turns
                    foreground when hovered or pressed. Dark rests as foreground, lightens on hover, and returns to
                    foreground when pressed. No underline in any state.
                </p>
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

const inputSizeSamples = [
    { height: "40px", size: "lg" },
    { height: "36px", size: "default" },
    { height: "32px", size: "sm" },
    { height: "28px", size: "xs" },
] as const;

function InputGallery() {
    const [value, setValue] = useState("morty");
    return (
        <div className="grid gap-6">
            <Specimen layout="stack" title="Sizes">
                {inputSizeSamples.map((sample) => (
                    <div className="flex items-center gap-3" key={sample.size}>
                        <span className="w-28 shrink-0 text-12 text-muted-foreground">
                            {sample.size} · {sample.height}
                        </span>
                        <Input
                            aria-label={`${sample.size} field`}
                            className="max-w-sm"
                            placeholder="Name this session"
                            size={sample.size}
                        />
                    </div>
                ))}
            </Specimen>
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
            <Specimen layout="stack" title="Types">
                <Input aria-label="Search" className="max-w-sm" placeholder="Search sessions…" type="search" />
                <Input aria-label="Port" className="max-w-sm" min={1} max={65535} placeholder="8080" type="number" />
                <Input
                    aria-label="Password"
                    autoComplete="current-password"
                    className="max-w-sm"
                    placeholder="Password"
                    type="password"
                />
            </Specimen>
        </div>
    );
}

const composerShellClassName =
    "w-full rounded-[20px] border border-border bg-background px-3 py-2 transition-[border-color,box-shadow] has-[:focus]:border-[var(--color-ring)] has-[:focus]:shadow-[var(--focus-ring-shadow)]";
const promptTextareaClassName =
    "min-h-0 [field-sizing:content] cursor-text rounded-[12px] bg-background p-3 text-[12px] leading-5 text-morty-text-2 lg:text-[12px]";
const formFieldShellClassName =
    "rounded-md border border-border bg-background pt-2 pr-1.5 pb-1.5 pl-3 has-[:focus]:border-ring has-[:focus]:shadow-[var(--focus-ring-shadow)]";
const formTextareaClassName =
    "min-h-16 resize-y bg-transparent p-0 text-[13px] leading-5 placeholder:text-[13px] lg:text-[13px]";
const multilineDraft = [
    "Ask the agent to tighten the button padding.",
    "Keep the label on the same row.",
    "Leave the disabled state faded.",
].join("\n");
const setupPrompt =
    "Fetch setup.md and complete the Morty setup for me. You may install missing prerequisites and pair this machine.";

function TextareaRow({ children, label }: { readonly children: ReactNode; readonly label: string }) {
    return (
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
            <span className="w-28 shrink-0 text-12 text-muted-foreground sm:pt-2">{label}</span>
            <div className="min-w-0 w-full max-w-lg">{children}</div>
        </div>
    );
}

function TextareaGallery() {
    const [composer, setComposer] = useState("Ask the agent to tighten the button padding.");
    const [notes, setNotes] = useState("The session closed before the files were written.");
    return (
        <div className="grid gap-6">
            <Specimen layout="stack" title="Composer">
                <TextareaRow label="Filled">
                    <div className={composerShellClassName}>
                        <Textarea
                            aria-label="Message"
                            onChange={(event) => setComposer(event.currentTarget.value)}
                            value={composer}
                        />
                    </div>
                </TextareaRow>
                <TextareaRow label="Placeholder">
                    <div className={composerShellClassName}>
                        <Textarea aria-label="Empty message" placeholder="Ask Morty to change this screen" />
                    </div>
                </TextareaRow>
                <TextareaRow label="Multiline">
                    <div className={composerShellClassName}>
                        <Textarea
                            aria-label="Multiline message"
                            className="[field-sizing:content]"
                            readOnly
                            value={multilineDraft}
                        />
                    </div>
                </TextareaRow>
                <TextareaRow label="Disabled">
                    <div className={composerShellClassName}>
                        <Textarea aria-label="Disabled message" disabled placeholder="Connect an agent to type" />
                    </div>
                </TextareaRow>
            </Specimen>
            <Specimen layout="stack" title="Read-only prompt">
                <TextareaRow label="Prompt">
                    <div className="overflow-hidden rounded-[12px] bg-muted">
                        <Textarea
                            aria-label="Agent setup prompt"
                            className={promptTextareaClassName}
                            onFocus={(event) => event.currentTarget.select()}
                            readOnly
                            rows={1}
                            value={setupPrompt}
                        />
                    </div>
                </TextareaRow>
            </Specimen>
            <Specimen layout="stack" title="Form field">
                <TextareaRow label="Placeholder">
                    <div className="grid gap-1.5">
                        <label className="text-12 font-medium text-foreground" htmlFor="playground-bug-description">
                            What went wrong?
                        </label>
                        <div className={formFieldShellClassName}>
                            <Textarea
                                className={formTextareaClassName}
                                id="playground-bug-description"
                                placeholder="Describe what you expected and what happened"
                            />
                        </div>
                    </div>
                </TextareaRow>
                <TextareaRow label="Filled">
                    <div className="grid gap-1.5">
                        <label className="text-12 font-medium text-foreground" htmlFor="playground-notes">
                            Notes
                        </label>
                        <div className={formFieldShellClassName}>
                            <Textarea
                                className={formTextareaClassName}
                                id="playground-notes"
                                onChange={(event) => setNotes(event.currentTarget.value)}
                                value={notes}
                            />
                        </div>
                    </div>
                </TextareaRow>
                <TextareaRow label="Disabled">
                    <div className="grid gap-1.5">
                        <label className="text-12 font-medium text-foreground" htmlFor="playground-notes-disabled">
                            Notes
                        </label>
                        <div className={formFieldShellClassName}>
                            <Textarea
                                className={formTextareaClassName}
                                disabled
                                id="playground-notes-disabled"
                                value="Sending is unavailable until the computer is online."
                            />
                        </div>
                    </div>
                </TextareaRow>
            </Specimen>
        </div>
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
                <MortyAlert description="Morty is reconnecting…">
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
                <MortyAlert tone="neutral">Morty is reconnecting…</MortyAlert>
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
        restartCommand: null,
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
        restartCommand: null,
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
            <Specimen
                layout="stack"
                title="Failure with connection status: inline line keeps the switch-computer action"
            >
                <MortyAlert
                    description={
                        <ConnectionNotice
                            feedback={waiting}
                            footer={
                                <a className={`inline-flex text-xs font-medium ${textLinkClassName}`} href="#computer">
                                    Switch to Online computer
                                </a>
                            }
                            inline
                            onRetryNow={noop}
                            onReopen={noop}
                        />
                    }
                >
                    Files must be between 1 byte and 32 MB.
                </MortyAlert>
            </Specimen>
            <Specimen layout="stack" title="Failure: reconnect failed">
                <ConnectionNotice feedback={failed} onRetryNow={noop} onReopen={noop} />
            </Specimen>
            <Specimen layout="stack" title="Informational: connecting (compact chip on the chat surface)">
                <div className="rounded-xl bg-card p-4">
                    <ConnectionNotice feedback={waiting} onRetryNow={noop} onReopen={noop} />
                </div>
            </Specimen>
            <Specimen layout="stack" title="Informational: computer offline with another online computer to switch to">
                <div className="rounded-xl bg-card p-4">
                    <ConnectionNotice
                        feedback={waiting}
                        footer={
                            <a className={`inline-flex text-xs font-medium ${textLinkClassName}`} href="#computer">
                                Switch to Online computer
                            </a>
                        }
                        onRetryNow={noop}
                        onReopen={noop}
                    />
                </div>
            </Specimen>
            <Specimen layout="stack" title="Informational: reconnecting">
                <ConnectionNotice feedback={retrying} onRetryNow={noop} onReopen={noop} />
            </Specimen>
            <Specimen layout="stack" title="Informational: session closed">
                <ConnectionNotice feedback={closed} onRetryNow={noop} onReopen={noop} />
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

function dialogGalleryShellProps(open: DialogGalleryOpen): {
    readonly appearance?: "default" | "setup" | "surface";
    readonly busy?: boolean;
    readonly size?: "medium" | "large" | "wide";
    readonly variant?: DialogVariant;
} {
    switch (open) {
        case "reference":
            return { variant: "identitySharing" };
        case "confirm":
        case "form":
        case "scroll":
            return { appearance: "default" };
        case "setup":
            return { appearance: "setup" };
        case "surface":
            return { appearance: "surface" };
        case "busy":
            return { appearance: "default", busy: true };
        case "medium":
            return { appearance: "default", size: "medium" };
        case "large":
            return { appearance: "default", size: "large" };
        case "wide":
            return { appearance: "default", size: "wide" };
        default:
            return { appearance: "default" };
    }
}

function dialogGalleryTitle(open: DialogGalleryOpen): string {
    switch (open) {
        case "reference":
            return "Continue on another device";
        case "confirm":
            return "Delete this session?";
        case "form":
            return "Rename session";
        case "scroll":
            return "Review activity";
        case "busy":
            return "Saving session";
        case "setup":
            return "Connect agent";
        case "surface":
            return "Devices with access";
        default:
            return "Network latency";
    }
}

function dialogGalleryDescription(open: DialogGalleryOpen): ReactNode {
    switch (open) {
        case "reference":
            return dialogGalleryVariantDescription.identitySharing ?? null;
        case "confirm":
            return "This removes the session from this browser. The agent on your computer keeps running.";
        case "form":
            return "The new name is shown in the sidebar.";
        case "scroll":
            return "Scroll the list. The title and the actions stay outside the scroll region.";
        case "busy":
            return "Close stays disabled until the work finishes.";
        case "setup":
            return dialogGalleryVariantDescription.connectAgentPairing ?? null;
        case "surface":
            return dialogGalleryVariantDescription.devicesAccess ?? null;
        default:
            return dialogGalleryVariantDescription.networkLatency ?? null;
    }
}

function DialogGallery() {
    const [open, setOpen] = useState<DialogGalleryOpen | null>(null);
    const [previewVariant, setPreviewVariant] = useState<DialogVariant | null>(null);
    const shellProps = open === null ? null : dialogGalleryShellProps(open);
    const previewCatalogEntry =
        previewVariant === null
            ? null
            : (dialogVariantCatalog.find((entry) => entry.variant === previewVariant) ?? null);
    return (
        <div className="grid gap-6">
            <Specimen title="Reference layout (default appearance)">
                <p className="mb-4 max-w-xl text-13 leading-5 text-muted-foreground">
                    Default appearance: title and close share one row; neutral copy in{" "}
                    <code className="text-12">description</code>; risks use <code className="text-12">MortyAlert</code>{" "}
                    inside <code className="text-12">dialogBodyStackClassName</code>. The scroll region does not include
                    the header or footer: title, description, and close stay above it, and actions passed as{" "}
                    <code className="text-12">footer</code> stay below it. Surface appearance (e.g. Devices) uses a{" "}
                    <code className="text-12">p-2</code> panel shell, close at the top-right, and{" "}
                    <code className="text-12">dialogSurfaceBodyClassName</code> for inner spacing.
                </p>
                <Button onClick={() => setOpen("reference")} variant="primary">
                    Open reference dialog
                </Button>
            </Specimen>
            <Specimen title="Confirm dialog">
                <p className="mb-4 max-w-xl text-13 leading-5 text-muted-foreground">
                    The question is the title. The consequence stays in <code className="text-12">description</code>.
                    Cancel and the confirming action use the same footer spacing as the form dialog.
                </p>
                <Button onClick={() => setOpen("confirm")} variant="primary">
                    Open confirm dialog
                </Button>
            </Specimen>
            <Specimen title="Form dialog">
                <p className="mb-4 max-w-xl text-13 leading-5 text-muted-foreground">
                    Fields sit in <code className="text-12">dialogBodyStackClassName</code>. Cancel and submit use{" "}
                    <code className="text-12">dialogPinnedFooterActionsClassName</code> as{" "}
                    <code className="text-12">footer</code>, outside the scroll region.
                </p>
                <Button onClick={() => setOpen("form")} variant="primary">
                    Open form dialog
                </Button>
            </Specimen>
            <Specimen title="Scrollable dialog">
                <p className="mb-4 max-w-xl text-13 leading-5 text-muted-foreground">
                    The dialog scroll region does not include the header or footer. Title, description, and close stay
                    above the list. Cancel and Done are the <code className="text-12">footer</code>, so they stay below
                    it.
                </p>
                <Button onClick={() => setOpen("scroll")} variant="primary">
                    Open scrollable dialog
                </Button>
            </Specimen>
            <Specimen title="Overlay width ladder (desktop max / fixed width)">
                <p className="mb-4 max-w-xl text-13 leading-5 text-muted-foreground">
                    Change values in <code className="text-12">components/ui/overlay-width.ts</code>. Mobile bottom
                    sheets stay full width; fullscreen and drawer surfaces are not listed here.
                </p>
                <dl className="grid max-w-2xl gap-3 text-13 leading-5">
                    {overlayWidthLadder.map(({ token, label, usage }) => (
                        <div
                            key={token}
                            className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-0.5 border-b border-border pb-3 last:border-0"
                        >
                            <dt className="font-mono font-semibold tabular-nums">{overlayWidthPx[token]}px</dt>
                            <dd className="font-medium">{label}</dd>
                            <dd className="col-span-2 text-muted-foreground">{usage}</dd>
                        </div>
                    ))}
                </dl>
            </Specimen>
            <Specimen title="Product dialog variants (`dialog-variant.ts`)">
                <p className="mb-4 max-w-xl text-13 leading-5 text-muted-foreground">
                    Each shipped dialog passes <code className="text-12">variant</code> so width and shell come from{" "}
                    <code className="text-12">dialogVariantLayout</code>. Override with explicit{" "}
                    <code className="text-12">size</code> only when needed.
                </p>
                <dl className="grid max-w-2xl gap-3 text-13 leading-5">
                    {[...dialogVariantCatalog]
                        .sort((left, right) => left.widthPx - right.widthPx)
                        .map(({ variant, title, widthPx }) => (
                            <div
                                key={variant}
                                className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-b border-border pb-3 last:border-0"
                            >
                                <dt className="font-mono font-semibold tabular-nums">{widthPx}px</dt>
                                <dd className="font-medium">{title}</dd>
                                <dd className="row-span-2 justify-self-end sm:row-span-1">
                                    <Button onClick={() => setPreviewVariant(variant)} size="sm" variant="outline">
                                        Open
                                    </Button>
                                </dd>
                                <dd className="col-span-2 font-mono text-12 text-muted-foreground sm:col-span-1">
                                    {variant}
                                </dd>
                            </div>
                        ))}
                </dl>
            </Specimen>
            <Specimen title="Shell previews">
                <Button onClick={() => setOpen("default")} variant="outline">
                    Default
                </Button>
                <Button onClick={() => setOpen("setup")} variant="outline">
                    Setup
                </Button>
                <Button onClick={() => setOpen("surface")} variant="outline">
                    Surface
                </Button>
                <Button onClick={() => setOpen("medium")} variant="outline">
                    Medium
                </Button>
                <Button onClick={() => setOpen("large")} variant="outline">
                    Large
                </Button>
                <Button onClick={() => setOpen("wide")} variant="outline">
                    Wide
                </Button>
                <Button onClick={() => setOpen("busy")} variant="outline">
                    Busy
                </Button>
                {shellProps !== null && open !== null && (
                    <Dialog
                        {...shellProps}
                        description={dialogGalleryDescription(open)}
                        footer={dialogGalleryShellFooter(open, () => setOpen(null))}
                        onClose={() => setOpen(null)}
                        title={dialogGalleryTitle(open)}
                    >
                        {open === "reference" ? (
                            <DialogGalleryReferenceBody />
                        ) : open === "confirm" ? null : open === "form" ? (
                            <DialogGalleryFormBody onClose={() => setOpen(null)} />
                        ) : open === "scroll" ? (
                            <DialogGalleryScrollBody />
                        ) : open === "surface" ? (
                            <div className={dialogSurfaceBodyClassName}>
                                <p className="text-13 leading-5 text-morty-text-3">
                                    Surface dialogs keep a <code className="text-12">p-2</code> outer shell; body
                                    content uses <code className="text-12">dialogSurfaceBodyClassName</code> (e.g. Open
                                    Session).
                                </p>
                            </div>
                        ) : open === "setup" ? (
                            <DialogGalleryPairingBody actionPresentation="setup-card" />
                        ) : open === "busy" ? (
                            <p className="text-13 leading-5 text-muted-foreground">
                                Use the button below to finish the work and re-enable close.
                            </p>
                        ) : (
                            <DialogGalleryPlaceholderBody />
                        )}
                    </Dialog>
                )}
                {previewCatalogEntry !== null && previewVariant !== null && (
                    <Dialog
                        variant={previewVariant}
                        description={
                            dialogGalleryVariantDescription[previewVariant] ??
                            "Product copy for this dialog lives on the call site."
                        }
                        footer={dialogGalleryFooterForVariant(previewVariant, () => setPreviewVariant(null))}
                        onClose={() => setPreviewVariant(null)}
                        title={previewCatalogEntry.title}
                    >
                        {dialogGalleryBodyForVariant(previewVariant)}
                    </Dialog>
                )}
            </Specimen>
        </div>
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
            <WorkingIndicator owner={null} startedAt={startedAt} />
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

const previewSessionId = "preview-session";
const noBusyInteractions: ReadonlySet<string> = new Set();
const noFileChanges: ReadonlyMap<string, readonly PermissionFileChange[]> = new Map();

const previewPermissionOptions = [
    { kind: "allow_once", name: "Yes", optionId: "allow-once" },
    { kind: "allow_always", name: "Allow for this session", optionId: "allow-always" },
    { kind: "reject_once", name: "No", optionId: "reject-once" },
] as const;

const pendingPermission: PermissionInteraction = {
    details: {
        cwd: "/workspace/morty",
        locations: [
            { line: 42, path: "packages/web/src/components/chat/session-interactions.tsx" },
            { path: "packages/web/src/styles.css" },
        ],
        rawInput: {
            command: "pnpm --filter @morty-build/web test -- --run tests/session-interactions.integration.test.tsx",
            description: "Run the session interaction integration tests",
        },
    },
    interactionId: "preview-permission",
    options: previewPermissionOptions,
    sessionId: previewSessionId,
    state: { kind: "pending" },
    title: "Run the session interaction tests",
    toolCallId: "preview-tool-call",
    toolKind: "execute",
};

const confirmedPermission: PermissionInteraction = {
    ...pendingPermission,
    interactionId: "preview-permission-confirmed",
    state: { kind: "resolved", optionId: "allow-once", outcome: "selected" },
};

const permissionWithoutDetails: PermissionInteraction = {
    interactionId: "preview-permission-without-details",
    options: previewPermissionOptions,
    sessionId: previewSessionId,
    state: { kind: "pending" },
    title: "Edit the project configuration",
    toolCallId: "preview-tool-call-without-details",
    toolKind: "edit",
};

function previewField({
    defaultString = "",
    description = "",
    multiline = false,
    name,
    options = [],
    required = false,
    title,
    type,
}: {
    readonly defaultString?: string;
    readonly description?: string;
    readonly multiline?: boolean;
    readonly name: string;
    readonly options?: SessionElicitationField["options"];
    readonly required?: boolean;
    readonly title: string;
    readonly type: SessionElicitationField["type"];
}): SessionElicitationField {
    return {
        defaultBooleanValue: false,
        defaultNumberValue: 0,
        defaultStringValue: defaultString,
        description,
        format: "",
        hasDefaultValue: defaultString.length > 0,
        maximum: "",
        maximumLength: "",
        minimum: "",
        minimumLength: "",
        ...(multiline ? { multiline: true } : {}),
        name,
        options,
        pattern: "",
        required,
        title,
        type,
    };
}

const previewFormFields = [
    previewField({
        description: "The branch the agent should push to.",
        name: "branch",
        required: true,
        title: "Branch",
        type: "string",
    }),
    previewField({
        name: "environment",
        options: [
            { description: "", label: "Staging", value: "staging" },
            { description: "", label: "Production", value: "production" },
        ],
        title: "Environment",
        type: "select",
    }),
    previewField({ name: "retries", title: "Retries", type: "integer" }),
    previewField({ name: "notify", title: "Notify the team when it finishes", type: "boolean" }),
    previewField({ multiline: true, name: "notes", title: "Notes", type: "string" }),
] as const;

const pendingElicitation: ElicitationInteraction = {
    fields: previewFormFields,
    interactionId: "preview-elicitation",
    message: "Which branch should I deploy, and how should I report back?",
    mode: "form",
    sessionId: previewSessionId,
    state: { kind: "pending" },
    url: "",
};

const answeredElicitation: ElicitationInteraction = {
    ...pendingElicitation,
    interactionId: "preview-elicitation-answered",
    state: {
        action: "accept",
        content: JSON.stringify({ branch: "feature/interactions", environment: "staging", notify: true, retries: 2 }),
        kind: "resolved",
    },
};

const pendingUrlElicitation: ElicitationInteraction = {
    fields: [],
    interactionId: "preview-elicitation-url",
    message: "Sign in to the deployment service to continue.",
    mode: "url",
    sessionId: previewSessionId,
    state: { kind: "pending" },
    url: "https://deploy.example.com/authorize?session=preview-session",
};

const acceptedUrlElicitation: ElicitationInteraction = {
    ...pendingUrlElicitation,
    interactionId: "preview-elicitation-url-accepted",
    state: { action: "accept", content: "", kind: "submitted" },
};

function SessionInteractionsGallery() {
    const noop = () => {};
    const specimens = [
        { elicitations: [], error: "", permissions: [pendingPermission], title: "Permission: pending" },
        {
            busyInteractionIds: new Set([pendingPermission.interactionId]),
            elicitations: [],
            error: "",
            permissions: [pendingPermission],
            title: "Permission: responding (collapsed while the response sends)",
        },
        {
            elicitations: [],
            error: "",
            permissions: [confirmedPermission],
            title: "Permission: confirmed",
        },
        {
            elicitations: [],
            error: "",
            permissions: [permissionWithoutDetails],
            title: "Permission: the agent sent no tool details",
        },
        { elicitations: [pendingElicitation], error: "", permissions: [], title: "Information request: form" },
        {
            busyInteractionIds: new Set([pendingElicitation.interactionId]),
            elicitations: [pendingElicitation],
            error: "",
            permissions: [],
            title: "Information request: form, responding",
        },
        {
            elicitations: [answeredElicitation],
            error: "",
            permissions: [],
            title: "Information request: form, answered",
        },
        {
            elicitations: [pendingUrlElicitation],
            error: "",
            permissions: [],
            title: "Information request: open a page",
        },
        {
            elicitations: [acceptedUrlElicitation],
            error: "",
            permissions: [],
            title: "Information request: page opened, waiting for the agent",
        },
        {
            elicitations: [],
            error: "The response could not be delivered. Try again.",
            permissions: [pendingPermission],
            title: "Permission with a failed response",
        },
        {
            elicitations: [pendingElicitation],
            error: "",
            permissions: [pendingPermission],
            title: "Stacked: permission above an information request",
        },
    ] as const;
    // Each specimen's form keeps what was typed, as the Session's answer drafts do in the product.
    const [answerDrafts, setAnswerDrafts] = useState<
        ReadonlyMap<string, Readonly<Record<string, ElicitationFieldValue>>>
    >(new Map());
    return (
        <div className="grid max-w-xl gap-6">
            {specimens.map((specimen) => (
                <Specimen key={specimen.title} layout="stack" title={specimen.title}>
                    <SessionInteractionCards
                        busyInteractionIds={
                            "busyInteractionIds" in specimen ? specimen.busyInteractionIds : noBusyInteractions
                        }
                        answerDrafts={answerDrafts}
                        elicitations={specimen.elicitations}
                        error={specimen.error}
                        fileChanges={noFileChanges}
                        onElicitationAnswer={(interactionId, fieldName, value) =>
                            setAnswerDrafts((drafts) =>
                                new Map(drafts).set(interactionId, {
                                    ...(drafts.get(interactionId) ?? {}),
                                    [fieldName]: value,
                                }),
                            )
                        }
                        onElicitationResponse={noop}
                        onPermissionResponse={noop}
                        onStop={noop}
                        permissions={specimen.permissions}
                    />
                </Specimen>
            ))}
        </div>
    );
}

const galleries = {
    alert: AlertGallery,
    "attempt-failure": AttemptFailureGallery,
    "auto-select-input": AutoSelectInputGallery,
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
    "menu-select": MenuSelectGallery,
    message: MessageGallery,
    "native-session-directory-placeholder": NativeSessionDirectoryPlaceholderGallery,
    "navigation-card": NavigationCardGallery,
    "option-select": OptionSelectGallery,
    popover: PopoverGallery,
    radius: RadiusGallery,
    "session-agent-tabs": SessionAgentTabsGallery,
    "session-interactions": SessionInteractionsGallery,
    spinner: SpinnerGallery,
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
