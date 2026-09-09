import { useAuth } from "@clerk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select } from "../../components/ui/select.tsx";
import {
    type BotSetup,
    type BotSetupInput,
    type ManagedMobiusBot,
    type MobiusBotsRequests,
    type MobiusProject,
    NativeMobiusRequests,
    ProjectOwnerCredentials,
} from "../../view-models/mobius/requests.ts";
import { waitForClerk } from "../../view-models/workspaces/clerk-directory.ts";
import type { ProjectApplicationProps } from "./workspace-applications.tsx";

type Resource<T> =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly value: T;
          readonly refresh:
              | { readonly kind: "idle" }
              | { readonly kind: "pending" }
              | { readonly kind: "failed"; readonly message: string };
      }
    | { readonly kind: "failed"; readonly message: string };
function useDialogLifetime() {
    const lifetime = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        return () => {
            controller.abort();
            lifetime.current = null;
        };
    }, []);
    return lifetime;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Mobius request failed. Try again.";
}
function useResource<T>(load: (signal: AbortSignal) => Promise<T>, revision: number, retain = false): Resource<T> {
    const [state, setState] = useState<Resource<T>>({ kind: "loading" });
    // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh reloads the resource.
    useEffect(() => {
        const controller = new AbortController();
        setState((previous) =>
            retain && previous.kind === "ready" ? { ...previous, refresh: { kind: "pending" } } : { kind: "loading" },
        );
        void load(controller.signal)
            .then((value) => {
                if (!controller.signal.aborted) {
                    setState({ kind: "ready", value, refresh: { kind: "idle" } });
                }
            })
            .catch((error) => {
                if (!controller.signal.aborted) {
                    setState((previous) =>
                        retain && previous.kind === "ready"
                            ? { ...previous, refresh: { kind: "failed", message: errorMessage(error) } }
                            : { kind: "failed", message: errorMessage(error) },
                    );
                }
            });
        return () => controller.abort();
    }, [load, revision, retain]);
    return state;
}
function label(bot: { readonly lifecycle: string; readonly setupStatus?: string | undefined }) {
    if (bot.setupStatus === "requested") {
        return "Awaiting runtime approval";
    }
    if (bot.lifecycle === "active") {
        return "Ready";
    }
    if (bot.lifecycle === "suspended") {
        return "Suspended";
    }
    if (bot.lifecycle === "archived") {
        return "Archived";
    }
    return bot.setupStatus === "unavailable" ? "Setup failed" : "Needs setup";
}
export function ProjectBotManagement({ onChannelSelected }: ProjectApplicationProps) {
    const { orgId, getToken, isLoaded } = useAuth();
    const token = useCallback((signal: AbortSignal) => waitForClerk(() => getToken(), signal), [getToken]);
    const requests = useMemo(
        () =>
            orgId
                ? new NativeMobiusRequests(
                      window.location.origin,
                      new ProjectOwnerCredentials(orgId, window.localStorage),
                      token,
                  )
                : null,
        [orgId, token],
    );
    const selectProject = useCallback(
        (projectId: string) => onChannelSelected(requests?.credentials.channel(projectId) ?? null),
        [requests, onChannelSelected],
    );
    if (!isLoaded) {
        return <p role="status">Loading workspace…</p>;
    }
    if (!requests) {
        return <p role="alert">Select a workspace to manage projects and bots.</p>;
    }
    return <MobiusBots key={orgId} requests={requests} onProjectSelected={selectProject} />;
}
export function MobiusBots({
    requests,
    onProjectSelected,
}: {
    readonly requests: MobiusBotsRequests;
    readonly onProjectSelected?: (projectId: string) => void;
}) {
    const [revision, refresh] = useState(0);
    const projects = useResource(requests.listProjects, revision);
    const [selected, select] = useState("");
    const [pairing, setPairing] = useState(false);
    const projectId =
        projects.kind === "ready" && projects.value.some((p) => p.projectId === selected)
            ? selected
            : projects.kind === "ready" && projects.value.length === 1
              ? (projects.value[0]?.projectId ?? "")
              : "";
    useEffect(() => {
        onProjectSelected?.(projectId);
    }, [projectId, onProjectSelected]);
    return (
        <Card className="grid gap-5 p-5 sm:p-6">
            <header>
                <h2 className="text-xl font-semibold">Projects and bots</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                    Manage your Mobius runtimes, projects, and bots.
                </p>
            </header>
            {projects.kind === "failed" ? (
                <>
                    <p role="alert">{projects.message}</p>
                    <Button variant="outline" onClick={() => refresh((r) => r + 1)}>
                        Retry projects
                    </Button>
                </>
            ) : projects.kind === "loading" ? (
                <p role="status">Loading projects…</p>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-40 flex-1">
                            <Select
                                label="Mobius project"
                                value={projectId}
                                onValueChange={select}
                                options={projects.value.map((p: MobiusProject) => ({
                                    value: p.projectId,
                                    label: p.displayName,
                                }))}
                            />
                        </div>
                        <Button variant="outline" aria-label="Pair new project" onClick={() => setPairing(true)}>
                            New pair
                        </Button>
                    </div>
                    {projects.value.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Pair a runtime to create your first project.</p>
                    ) : null}
                    {projectId ? <ProjectBots key={projectId} projectId={projectId} requests={requests} /> : null}
                </>
            )}
            {pairing ? (
                <PairingDialog
                    requests={requests}
                    onClose={() => setPairing(false)}
                    onPaired={(id) => {
                        select(id);
                        refresh((r) => r + 1);
                        setPairing(false);
                    }}
                />
            ) : null}
        </Card>
    );
}
function PairingDialog({
    requests,
    onClose,
    onPaired,
}: {
    readonly requests: MobiusBotsRequests;
    readonly onClose: () => void;
    readonly onPaired: (projectId: string) => void;
}) {
    const pairing = useResource(requests.createPairing, 0);
    const [status, setStatus] = useState<"pending" | "paired" | "expired">("pending");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const lifetime = useDialogLifetime();
    return (
        <Dialog
            title="Pair a Mobius runtime"
            description="Run this command on the machine you want to connect."
            onClose={onClose}
        >
            {pairing.kind === "loading" ? (
                <p role="status">Creating pairing…</p>
            ) : pairing.kind === "failed" ? (
                <p role="alert">{pairing.message}</p>
            ) : (
                <div className="grid gap-4">
                    <Input
                        aria-label="Pairing command"
                        readOnly
                        value={`npx --yes @moxt-ai/mobius pair --url "${pairing.value.relayUrl}" --code ${pairing.value.pairingCode}`}
                    />
                    <p role="status">
                        {status === "paired"
                            ? "Runtime paired"
                            : status === "expired"
                              ? "Pairing expired. Close and create a new pairing."
                              : "Waiting for your runtime"}
                    </p>
                    <Button
                        disabled={busy || status === "expired"}
                        variant="outline"
                        onClick={() => {
                            const controller = lifetime.current;
                            if (controller === null || busy) {
                                return;
                            }
                            setBusy(true);
                            setError("");
                            void requests
                                .pairingStatus(pairing.value, controller.signal)
                                .then((status) => {
                                    if (!controller.signal.aborted) {
                                        setStatus(status);
                                    }
                                })
                                .catch((e) => {
                                    if (!controller.signal.aborted) {
                                        setError(errorMessage(e));
                                    }
                                })
                                .finally(() => {
                                    if (!controller.signal.aborted) {
                                        setBusy(false);
                                    }
                                });
                        }}
                    >
                        {busy ? "Checking pairing…" : "Check pairing"}
                    </Button>
                    {status === "paired" ? (
                        <Button onClick={() => onPaired(pairing.value.projectId)}>Use project</Button>
                    ) : null}
                </div>
            )}
            {error ? <p role="alert">{error}</p> : null}
        </Dialog>
    );
}
type ProjectDialog =
    | { readonly kind: "closed" }
    | { readonly kind: "create" }
    | { readonly kind: "setup"; readonly bot: ManagedMobiusBot };
function ProjectBots({ projectId, requests }: { readonly projectId: string; readonly requests: MobiusBotsRequests }) {
    const [revision, refresh] = useState(0);
    const load = useCallback((signal: AbortSignal) => requests.listBots(projectId, signal), [projectId, requests]);
    const loadStatus = useCallback(
        (signal: AbortSignal) => requests.projectStatus(projectId, signal),
        [projectId, requests],
    );
    const resource = useResource(load, revision, true);
    const status = useResource(loadStatus, revision);
    const refreshing = resource.kind === "ready" && resource.refresh.kind === "pending";
    const [dialog, setDialog] = useState<ProjectDialog>({ kind: "closed" });
    const canManage = requests.canManageProject(projectId);
    const changed = () => refresh((r) => r + 1);
    return (
        <div className="grid gap-4">
            {!canManage ? (
                <p role="status" className="text-sm text-muted-foreground">
                    Owner access is required. Use the browser that paired this project to manage its bots.
                </p>
            ) : null}
            <div className="flex justify-between gap-3">
                <Button variant="outline" onClick={changed} disabled={resource.kind === "loading" || refreshing}>
                    {refreshing ? "Refreshing bots…" : "Refresh bots"}
                </Button>
                <Button aria-label="Add Mobius bot" disabled={!canManage} onClick={() => setDialog({ kind: "create" })}>
                    Add bot
                </Button>
            </div>
            {resource.kind === "ready" && resource.refresh.kind === "failed" ? (
                <p role="alert">{resource.refresh.message} Showing previously loaded bots. Refresh to try again.</p>
            ) : null}
            {status.kind === "failed" ? <p role="status">Runtime status unavailable</p> : null}
            {resource.kind === "loading" ? (
                <p role="status">Loading bots…</p>
            ) : resource.kind === "failed" ? (
                <p role="alert">{resource.message}</p>
            ) : (
                <ul className="grid gap-3">
                    {resource.value.map((bot) => (
                        <li
                            aria-label={bot.displayName}
                            key={bot.botId}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                        >
                            <strong className="text-sm">{bot.displayName}</strong>
                            <div className="flex flex-wrap items-center gap-3 text-xs">
                                <span>{label(bot)}</span>
                                <span>
                                    {status.kind === "ready"
                                        ? status.value
                                        : status.kind === "loading"
                                          ? "Checking runtime…"
                                          : "Status unknown"}
                                </span>
                                {bot.lifecycle !== "archived" ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={!canManage}
                                        aria-label={`Set up ${bot.displayName}`}
                                        onClick={() => setDialog({ kind: "setup", bot })}
                                    >
                                        {bot.lifecycle === "draft" ? "Set up" : "Settings"}
                                    </Button>
                                ) : null}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {dialog.kind === "create" ? (
                <CreateBot
                    projectId={projectId}
                    requests={requests}
                    onClose={() => setDialog({ kind: "closed" })}
                    onCreated={() => {
                        changed();
                        setDialog({ kind: "closed" });
                    }}
                />
            ) : dialog.kind === "setup" ? (
                <SetupDialog
                    projectId={projectId}
                    bot={dialog.bot}
                    requests={requests}
                    onClose={() => setDialog({ kind: "closed" })}
                    onChanged={changed}
                />
            ) : null}
        </div>
    );
}
function CreateBot({
    projectId,
    requests,
    onClose,
    onCreated,
}: {
    readonly projectId: string;
    readonly requests: MobiusBotsRequests;
    readonly onClose: () => void;
    readonly onCreated: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const lifetime = useDialogLifetime();
    return (
        <Dialog
            title="Create Mobius bot"
            description="Give your bot a name and description."
            onClose={onClose}
            busy={busy}
        >
            <form
                className="grid gap-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    const controller = lifetime.current;
                    if (controller === null || busy) {
                        return;
                    }
                    const form = new FormData(event.currentTarget);
                    const displayName = form.get("name");
                    const description = form.get("description");
                    if (typeof displayName !== "string" || typeof description !== "string") {
                        return;
                    }
                    setBusy(true);
                    setError("");
                    void requests
                        .createBot(projectId, { displayName, description }, controller.signal)
                        .then(() => {
                            if (!controller.signal.aborted) {
                                onCreated();
                            }
                        })
                        .catch((e) => {
                            if (!controller.signal.aborted) {
                                setError(errorMessage(e));
                            }
                        })
                        .finally(() => {
                            if (!controller.signal.aborted) {
                                setBusy(false);
                            }
                        });
                }}
            >
                <label htmlFor="native-bot-name" className="grid gap-2">
                    Mobius bot name
                    <Input id="native-bot-name" name="name" required maxLength={100} />
                </label>
                <label htmlFor="native-bot-description" className="grid gap-2">
                    Description
                    <Input id="native-bot-description" name="description" />
                </label>
                <Button type="submit" disabled={busy}>
                    {busy ? "Creating bot…" : "Create Mobius bot"}
                </Button>
                {error ? <p role="alert">{error}</p> : null}
            </form>
        </Dialog>
    );
}
function SetupDialog({
    projectId,
    bot,
    requests,
    onClose,
    onChanged,
}: {
    readonly projectId: string;
    readonly bot: ManagedMobiusBot;
    readonly requests: MobiusBotsRequests;
    readonly onClose: () => void;
    readonly onChanged: () => void;
}) {
    const [revision, refresh] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const lifetime = useDialogLifetime();
    const load = useCallback(
        (signal: AbortSignal) => requests.getBotSetup(projectId, bot.botId, signal),
        [requests, projectId, bot.botId],
    );
    const setup = useResource(load, revision);
    return (
        <Dialog
            title={`Set up ${bot.displayName}`}
            description="Choose the local runtime, agent, working directory, and instructions."
            onClose={onClose}
            busy={busy}
        >
            {setup.kind === "ready" ? (
                <>
                    <p role="status" className="mb-4">
                        {label({ lifecycle: setup.value.lifecycle, setupStatus: setup.value.configuration.kind })}
                    </p>
                    <SetupForm
                        key={`${revision}:${setup.value.behaviorRevision}`}
                        setup={setup.value}
                        busy={busy}
                        onSave={(input) => {
                            const controller = lifetime.current;
                            if (controller === null || busy) {
                                return;
                            }
                            setBusy(true);
                            setError("");
                            void requests
                                .configureBot(projectId, bot.botId, input, controller.signal)
                                .then(() => {
                                    if (!controller.signal.aborted) {
                                        refresh((r) => r + 1);
                                        onChanged();
                                    }
                                })
                                .catch((e) => {
                                    if (!controller.signal.aborted) {
                                        setError(errorMessage(e));
                                    }
                                })
                                .finally(() => {
                                    if (!controller.signal.aborted) {
                                        setBusy(false);
                                    }
                                });
                        }}
                    />
                </>
            ) : setup.kind === "failed" ? (
                <p role="alert">{setup.message}</p>
            ) : (
                <p role="status">Loading setup…</p>
            )}
            {error ? <p role="alert">{error}</p> : null}
            <Button
                className="mt-4"
                variant="outline"
                disabled={busy}
                onClick={() => {
                    refresh((r) => r + 1);
                    onChanged();
                }}
            >
                Refresh setup status
            </Button>
        </Dialog>
    );
}
function SetupForm({
    setup,
    busy,
    onSave,
}: {
    readonly setup: BotSetup;
    readonly busy: boolean;
    readonly onSave: (input: BotSetupInput) => void;
}) {
    const configuration = setup.configuration;
    const [runtimeId, setRuntime] = useState(
        configuration.kind === "not-configured" ? (setup.runtimes[0]?.runtimeId ?? "") : configuration.runtimeId,
    );
    const runtime = setup.runtimes.find((r) => r.runtimeId === runtimeId);
    const [agentRef, setAgent] = useState(
        configuration.kind === "not-configured" ? (runtime?.agents[0]?.id ?? "") : configuration.agentRef,
    );
    const [workspaceRef, setWorkspace] = useState(
        configuration.kind === "not-configured" ? "default" : configuration.workspaceRef,
    );
    const custom = workspaceRef !== "default" && workspaceRef !== "home";
    let savedPath = "";
    if (configuration.kind !== "not-configured" && configuration.workspaceRef.startsWith("path-")) {
        try {
            savedPath = new TextDecoder().decode(
                Uint8Array.from(
                    atob(configuration.workspaceRef.slice(5).replaceAll("-", "+").replaceAll("_", "/")),
                    (c) => c.charCodeAt(0),
                ),
            );
        } catch {
            /* Resolved locally when saved again. */
        }
    }
    const blocked = busy || configuration.kind === "requested" || setup.lifecycle === "archived";
    return (
        <form
            className="grid gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const instructions = form.get("instructions");
                const path = form.get("path");
                if (typeof instructions !== "string") {
                    return;
                }
                const target =
                    custom && typeof path === "string"
                        ? `path-${btoa(String.fromCharCode(...new TextEncoder().encode(path.trim())))
                              .replaceAll("+", "-")
                              .replaceAll("/", "_")
                              .replace(/=+$/u, "")}`
                        : workspaceRef;
                onSave({
                    runtimeId,
                    agentRef,
                    workspaceRef: target,
                    instructions,
                    lifecycleRevision: setup.lifecycleRevision,
                    behaviorRevision: setup.behaviorRevision,
                });
            }}
        >
            <fieldset disabled={blocked} className="grid gap-4">
                <Select
                    label="Runtime"
                    value={runtimeId}
                    onValueChange={(id) => {
                        setRuntime(id);
                        setAgent("");
                    }}
                    options={setup.runtimes.map((r) => ({
                        value: r.runtimeId,
                        label: `${r.machineName} — ${r.online ? "connected" : "offline"}`,
                    }))}
                    disabled={blocked}
                />
                <Select
                    label="Local agent"
                    value={agentRef}
                    onValueChange={setAgent}
                    options={runtime?.agents.map((a) => ({ value: a.id, label: a.label })) ?? []}
                    disabled={blocked}
                />
                <Select
                    label="Working directory"
                    value={custom ? "custom" : workspaceRef}
                    onValueChange={setWorkspace}
                    options={[
                        { value: "default", label: "Runtime's default directory" },
                        { value: "home", label: "Home directory" },
                        { value: "custom", label: "Custom directory" },
                    ]}
                    disabled={blocked}
                />
                {custom ? (
                    <label htmlFor="native-bot-directory" className="grid gap-2">
                        Directory path
                        <Input
                            id="native-bot-directory"
                            name="path"
                            required
                            pattern="/.*"
                            maxLength={1024}
                            defaultValue={savedPath}
                            placeholder="/Users/you/project"
                        />
                    </label>
                ) : null}
                <label className="grid gap-2">
                    Bot instructions
                    <textarea
                        aria-label="Bot instructions"
                        name="instructions"
                        className="rounded-md border border-border bg-background p-3"
                        rows={4}
                        defaultValue={configuration.kind === "not-configured" ? "" : configuration.instructions}
                    />
                </label>
                <p className="text-xs text-muted-foreground">
                    Model: local agent default. Setup requires validation by the local runtime.
                </p>
                <Button type="submit" disabled={blocked || !runtimeId || !agentRef}>
                    Save setup
                </Button>
            </fieldset>
        </form>
    );
}
