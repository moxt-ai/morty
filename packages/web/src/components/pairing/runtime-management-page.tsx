import type { MobiusRuntimeDescriptor, MobiusRuntimePairing } from "@moxt-ai/mobius-sdk";
import {
    ArrowLeft,
    Check,
    CircleCheck,
    Copy,
    Laptop,
    LoaderCircle,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    RefreshCw,
    Terminal,
    Trash2,
    Wifi,
    WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/view-models/chat-store";
import {
    createRuntimeManagementStore,
    formatRuntimeDate,
    type RuntimeDirectoryState,
    type RuntimeRevocationState,
    runtimeDisplayName,
    runtimePairingCommand,
} from "@/view-models/pairing/runtime-management-store";

function PairingDetails({
    checking,
    copyConfirmation,
    onCheck,
    onCopy,
    pairing,
}: {
    readonly checking: boolean;
    readonly copyConfirmation: string;
    readonly onCheck: () => void;
    readonly onCopy: (value: string, successMessage: string) => void;
    readonly pairing: MobiusRuntimePairing;
}) {
    const codeInputRef = useRef<HTMLInputElement>(null);
    const command = runtimePairingCommand(pairing);

    useEffect(() => {
        codeInputRef.current?.focus({ preventScroll: true });
        codeInputRef.current?.select();
    }, []);

    return (
        <section
            aria-labelledby="runtime-pairing-heading"
            className="mt-6 rounded-2xl border border-success/35 bg-success-subtle p-4 sm:p-5"
        >
            <div className="flex items-start gap-3">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-success shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                    <Terminal aria-hidden="true" className="size-[18px]" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-base font-semibold tracking-[-0.015em]" id="runtime-pairing-heading">
                        Run this on the other machine
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        The one-time code expires {formatRuntimeDate(pairing.expiresAt)}. It never contains your Project
                        owner credential.
                    </p>
                </div>
            </div>

            <label className="mt-5 block text-xs font-semibold" htmlFor="runtime-pairing-code">
                One-time pairing code
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 font-mono text-sm font-semibold tracking-[0.08em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    id="runtime-pairing-code"
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    ref={codeInputRef}
                    type="text"
                    value={pairing.pairingCode}
                />
                <Button
                    className="min-h-11 shrink-0"
                    onClick={() => onCopy(pairing.pairingCode, "Pairing code copied.")}
                    variant="outline"
                >
                    <Copy aria-hidden="true" className="size-4" /> Copy code
                </Button>
            </div>

            <label className="mt-4 block text-xs font-semibold" htmlFor="runtime-pairing-command">
                Pairing command
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    id="runtime-pairing-command"
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    type="text"
                    value={command}
                />
                <Button
                    className="min-h-11 shrink-0"
                    onClick={() => onCopy(command, "Pairing command copied.")}
                    variant="outline"
                >
                    {copyConfirmation === "Pairing command copied." ? (
                        <Check aria-hidden="true" className="size-4" />
                    ) : (
                        <Copy aria-hidden="true" className="size-4" />
                    )}
                    Copy command
                </Button>
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p aria-live="polite" className="min-h-5 text-xs leading-5 text-success">
                    {copyConfirmation}
                </p>
                <Button aria-busy={checking} className="min-h-11" disabled={checking} onClick={onCheck}>
                    {checking ? (
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : (
                        <RefreshCw aria-hidden="true" className="size-4" />
                    )}
                    Check connection
                </Button>
            </div>
        </section>
    );
}

function RuntimeList({
    channelId,
    directory,
    onCancelRevocation,
    onConfirmRevocation,
    onRequestRevocation,
    revocation,
}: {
    readonly channelId: string;
    readonly directory: Extract<RuntimeDirectoryState, { readonly kind: "ready" }>;
    readonly onCancelRevocation: (runtimeId: string) => void;
    readonly onConfirmRevocation: (runtime: MobiusRuntimeDescriptor) => void;
    readonly onRequestRevocation: (runtimeId: string) => void;
    readonly revocation: RuntimeRevocationState;
}) {
    const canManage = directory.canManage;

    return (
        <section aria-labelledby="project-runtimes-heading" className="mt-8">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold tracking-[-0.015em]" id="project-runtimes-heading">
                        Project Runtimes
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Each machine keeps an independent credential, connection, Agent catalog, and local grants.
                    </p>
                </div>
                <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                    {directory.runtimes.length.toString()} / 8
                </span>
            </div>

            <ul aria-label="Project runtimes" className="mt-4 grid gap-3">
                {directory.runtimes.map((runtime) => {
                    const name = runtimeDisplayName(runtime);
                    const confirming = revocation.kind === "confirming" && revocation.runtimeId === runtime.runtimeId;
                    const revoking = revocation.kind === "revoking" && revocation.runtimeId === runtime.runtimeId;
                    const failed = revocation.kind === "failed" && revocation.runtimeId === runtime.runtimeId;
                    return (
                        <li
                            className="rounded-2xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)] sm:p-5"
                            key={runtime.runtimeId}
                        >
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#eefaf3] text-[#218854]">
                                    <Laptop aria-hidden="true" className="size-5" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <strong className="text-sm font-semibold">{name}</strong>
                                        {runtime.channelId === channelId && (
                                            <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                                Current channel
                                            </span>
                                        )}
                                        <span
                                            className={
                                                runtime.online
                                                    ? "inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-[10px] font-semibold text-success"
                                                    : "inline-flex items-center gap-1 rounded-full bg-destructive/8 px-2 py-0.5 text-[10px] font-semibold text-destructive"
                                            }
                                        >
                                            {runtime.online ? (
                                                <Wifi aria-hidden="true" className="size-3" />
                                            ) : (
                                                <WifiOff aria-hidden="true" className="size-3" />
                                            )}
                                            {runtime.online ? "Online" : "Offline"}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                        {runtime.workspaceName}
                                    </p>
                                    <p className="mt-2 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                                        {runtime.runtimeId}
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-1.5">
                                        {runtime.agents.length === 0 ? (
                                            <span className="rounded-md bg-black/5 px-2 py-1 text-[11px] text-muted-foreground">
                                                No ready Agents
                                            </span>
                                        ) : (
                                            runtime.agents.map((agent) => (
                                                <span
                                                    className="rounded-md bg-black/5 px-2 py-1 text-[11px] font-medium text-foreground"
                                                    key={agent.id}
                                                >
                                                    {agent.label}
                                                </span>
                                            ))
                                        )}
                                    </div>
                                </div>
                                {canManage && !confirming && (
                                    <Button
                                        aria-busy={revoking}
                                        aria-label={`Revoke ${name}`}
                                        className="min-h-11 shrink-0 text-destructive hover:text-destructive"
                                        disabled={revocation.kind === "revoking"}
                                        id={`revoke-runtime-${runtime.runtimeId}`}
                                        onClick={() => onRequestRevocation(runtime.runtimeId)}
                                        variant="outline"
                                    >
                                        {revoking ? (
                                            <LoaderCircle
                                                aria-hidden="true"
                                                className="size-4 animate-spin motion-reduce:animate-none"
                                            />
                                        ) : (
                                            <Trash2 aria-hidden="true" className="size-4" />
                                        )}
                                        Revoke
                                    </Button>
                                )}
                            </div>

                            {confirming && (
                                <div
                                    className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 p-4"
                                    role="alert"
                                >
                                    <p className="text-sm font-semibold text-destructive">Revoke {name}?</p>
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                        Its daemon will disconnect immediately and work pinned to it will not move to
                                        another Runtime. Pairing it again creates a new Runtime identity.
                                    </p>
                                    <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                        <Button
                                            className="min-h-11"
                                            onClick={() => onCancelRevocation(runtime.runtimeId)}
                                            variant="outline"
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            aria-label={`Confirm revoke ${name}`}
                                            autoFocus
                                            className="min-h-11 bg-destructive text-white hover:bg-destructive/90"
                                            onClick={() => onConfirmRevocation(runtime)}
                                        >
                                            <Trash2 aria-hidden="true" className="size-4" /> Confirm revoke
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {failed && (
                                <p
                                    aria-live="polite"
                                    className="mt-3 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive"
                                >
                                    {revocation.message}
                                </p>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

function RuntimeManagementPanel({ channelId, projectId }: { readonly channelId: string; readonly projectId: string }) {
    const [controller] = useState(() => new AbortController());
    const [store] = useState(() => createRuntimeManagementStore(channelId, projectId));
    const viewModel = useStore(store);
    const { announcement, copyConfirmation, directory, pairing, revocation } = viewModel;

    useEffect(() => {
        void viewModel.loadDirectory(controller.signal);
        return () => controller.abort();
    }, [controller, viewModel.loadDirectory]);

    const cancelRevocation = (runtimeId: string): void => {
        viewModel.cancelRevocation();
        window.requestAnimationFrame(() => document.getElementById(`revoke-runtime-${runtimeId}`)?.focus());
    };

    const readyDirectory = directory.kind === "ready" ? directory : null;
    const ownerDirectory = directory.kind === "ready" && directory.canManage;
    const activePairing = pairing.kind === "pending" || pairing.kind === "checking" ? pairing.pairing : null;

    return (
        <section aria-labelledby="runtime-management-heading">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-2xl">
                    <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                        Project execution
                    </p>
                    <h2
                        className="mt-2 text-[28px] leading-9 font-semibold tracking-[-0.035em]"
                        id="runtime-management-heading"
                    >
                        Manage local machines
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Pair another computer into this Project without sharing your owner credential. Each computer
                        becomes a separate Runtime with its own local permissions and workspace.
                    </p>
                </div>
                {ownerDirectory &&
                    pairing.kind !== "creating" &&
                    pairing.kind !== "pending" &&
                    pairing.kind !== "checking" &&
                    pairing.kind !== "claimed" && (
                        <Button
                            className="min-h-11 shrink-0 sm:self-end"
                            onClick={() => void viewModel.startPairing(controller.signal)}
                        >
                            <Plus aria-hidden="true" className="size-4" /> Pair another machine
                        </Button>
                    )}
            </div>

            {directory.kind === "loading" && (
                <div
                    aria-busy="true"
                    aria-live="polite"
                    className="mt-5 flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm text-muted-foreground"
                >
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    Loading Project Runtimes…
                </div>
            )}

            {directory.kind === "failed" && (
                <div className="mt-5 flex flex-col gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm leading-6 text-destructive">{directory.message}</p>
                    <Button
                        className="min-h-11 shrink-0"
                        onClick={() => void viewModel.loadDirectory(controller.signal)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry
                    </Button>
                </div>
            )}

            {directory.kind === "ready" && !directory.canManage && (
                <div className="mt-5 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm leading-6 text-muted-foreground shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                    This browser has linked-device access. It can see Project Runtimes, but only the original owner
                    browser can pair or revoke local machines.
                </div>
            )}

            {pairing.kind === "creating" && (
                <div
                    aria-busy="true"
                    aria-live="polite"
                    className="mt-6 flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 text-sm text-muted-foreground"
                >
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    Creating a one-time Runtime pairing…
                </div>
            )}

            {activePairing !== null && (
                <PairingDetails
                    checking={pairing.kind === "checking"}
                    copyConfirmation={copyConfirmation}
                    onCheck={() => void viewModel.checkPairing(activePairing, controller.signal)}
                    onCopy={(value, message) => void viewModel.copyValue(value, message)}
                    pairing={activePairing}
                />
            )}

            {pairing.kind === "connected" && (
                <div
                    aria-live="polite"
                    className="mt-6 flex items-center gap-3 rounded-xl border border-success/30 bg-success-subtle px-4 py-3 text-sm text-success"
                >
                    <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
                    {pairing.machineName} is connected.
                </div>
            )}

            {pairing.kind === "claimed" && (
                <div className="mt-6 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-4">
                    <p className="text-sm font-semibold text-warning">{pairing.machineName} is paired but offline.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Keep the Mobius command running on that machine, then check its connection again.
                    </p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void viewModel.checkPairing(pairing.pairing, controller.signal)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Check connection
                    </Button>
                </div>
            )}

            {pairing.kind === "expired" && (
                <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4">
                    <p className="text-sm text-destructive">The one-time pairing code expired before it was claimed.</p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void viewModel.startPairing(controller.signal)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Create a new pairing
                    </Button>
                </div>
            )}

            {pairing.kind === "revoked" && (
                <p aria-live="polite" className="mt-6 rounded-xl bg-destructive/8 px-4 py-3 text-sm text-destructive">
                    This pending Runtime pairing was revoked. Create a new pairing to continue.
                </p>
            )}

            {pairing.kind === "creation-failed" && (
                <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4">
                    <p aria-live="polite" className="text-sm text-destructive">
                        {pairing.message}
                    </p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void viewModel.requestPairing(pairing.idempotencyKey, controller.signal)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry safely
                    </Button>
                </div>
            )}

            {pairing.kind === "check-failed" && (
                <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-4">
                    <p aria-live="polite" className="text-sm text-destructive">
                        {pairing.message}
                    </p>
                    <Button
                        className="mt-3 min-h-11"
                        onClick={() => void viewModel.checkPairing(pairing.pairing, controller.signal)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry status check
                    </Button>
                </div>
            )}

            <p aria-live="polite" className="mt-4 min-h-5 text-sm text-success">
                {announcement}
            </p>

            {readyDirectory !== null && (
                <RuntimeList
                    channelId={channelId}
                    directory={readyDirectory}
                    onCancelRevocation={cancelRevocation}
                    onConfirmRevocation={(runtime) => void viewModel.revokeRuntime(runtime, controller.signal)}
                    onRequestRevocation={viewModel.requestRevocation}
                    revocation={revocation}
                />
            )}
        </section>
    );
}

export function RuntimeManagementPage({
    channelId,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
    projectId,
}: {
    readonly channelId: string;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
    readonly projectId: string;
}) {
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);

    return (
        <>
            <header className="chat-header z-10 flex shrink-0 items-center border-b-[0.5px] border-black/6 bg-background/92 px-2.5 supports-[backdrop-filter]:backdrop-blur-xl md:px-[18px]">
                <Button
                    aria-controls="conversation-sidebar"
                    aria-expanded={sidebarOpen}
                    aria-label="Open conversation sidebar"
                    className="mr-[7px] size-11 lg:hidden"
                    id="conversation-sidebar-trigger"
                    onClick={() => setSidebarOpen(true)}
                    size="icon"
                    variant="ghost"
                >
                    <Menu aria-hidden="true" className="size-[18px]" />
                </Button>
                <Button
                    aria-label={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    className="mr-2 hidden lg:inline-flex"
                    onClick={onToggleDesktopSidebar}
                    size="icon"
                    title={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    variant="ghost"
                >
                    {desktopSidebarCollapsed ? (
                        <PanelLeftOpen aria-hidden="true" className="size-4" />
                    ) : (
                        <PanelLeftClose aria-hidden="true" className="size-4" />
                    )}
                </Button>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]">
                    <Laptop aria-hidden="true" className="size-4" />
                </span>
                <h1 className="ml-2 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">Local machines</h1>
                <Link
                    aria-label="Back to chat"
                    className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-11 sm:w-auto sm:gap-1.5 sm:px-3"
                    relative="path"
                    to=".."
                >
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    <span className="hidden sm:inline">Back to chat</span>
                </Link>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[980px] px-5 py-8 sm:px-8 sm:py-10">
                    <RuntimeManagementPanel channelId={channelId} key={channelId} projectId={projectId} />
                </div>
            </div>
        </>
    );
}
