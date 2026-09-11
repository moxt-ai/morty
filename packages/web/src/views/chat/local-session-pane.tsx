import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { ArrowLeft, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Select } from "../../components/ui/option-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import type { OpenLocalSession } from "./local-session-sidebar.tsx";

interface Message {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
}
type Operation =
    | { readonly kind: "idle" }
    | { readonly kind: "sending"; readonly commandId: string }
    | { readonly kind: "configuring" }
    | { readonly kind: "failed"; readonly message: string };

export function LocalSessionPane({
    session,
    onBack,
}: {
    readonly session: OpenLocalSession;
    readonly onBack: () => void;
}) {
    const [messages, setMessages] = useState<readonly Message[]>(() =>
        session.result.history.status === "available"
            ? session.result.history.messages.map((message, index) => ({
                  id: `history-${index}`,
                  role: message.role,
                  text: message.text,
              }))
            : [],
    );
    const [options, setOptions] = useState<readonly SessionConfigOption[]>(
        session.result.action === "preview" ? [] : session.result.ready.configOptions,
    );
    const [draft, setDraft] = useState("");
    const [operation, setOperation] = useState<Operation>({ kind: "idle" });
    const lifetime = useRef(new AbortController());
    const command = useRef("");
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        return () => {
            controller.abort();
            if (command.current !== "") {
                session.client.cancel({ commandId: command.current, sessionId: session.result.targetSessionId });
            }
        };
    }, [session]);
    const request = {
        agentId: session.agentRef,
        sessionId: session.result.targetSessionId,
        bindingId: "workspace",
        directoryId: session.entry.directoryId,
        additionalDirectoryIds: session.entry.additionalDirectories.map((directory) => directory.directoryId),
    };
    const send = async () => {
        if (
            session.result.action === "preview" ||
            draft.trim() === "" ||
            operation.kind === "sending" ||
            operation.kind === "configuring"
        ) {
            return;
        }
        const commandId = crypto.randomUUID();
        command.current = commandId;
        const prompt = draft.trim();
        setDraft("");
        setMessages((current) => [
            ...current,
            { id: commandId, role: "user", text: prompt },
            { id: `${commandId}-reply`, role: "assistant", text: "" },
        ]);
        setOperation({ kind: "sending", commandId });
        try {
            await session.client.prompt({
                ...request,
                commandId,
                prompt,
                observer: {
                    onDelta: (delta) => {
                        if (!lifetime.current.signal.aborted) {
                            setMessages((current) =>
                                current.map((message) =>
                                    message.id === `${commandId}-reply`
                                        ? { ...message, text: message.text + delta }
                                        : message,
                                ),
                            );
                        }
                    },
                },
            });
            if (!lifetime.current.signal.aborted) {
                setOperation({ kind: "idle" });
            }
        } catch (cause) {
            if (!lifetime.current.signal.aborted) {
                setOperation({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The agent could not complete the message.",
                });
            }
        } finally {
            command.current = "";
        }
    };
    const configure = async (option: SessionConfigOption, value: string) => {
        setOperation({ kind: "configuring" });
        try {
            const result = await session.client.configureSession(
                { ...request, configId: option.id, value, valueType: option.type, booleanValue: false },
                lifetime.current.signal,
            );
            if (!lifetime.current.signal.aborted) {
                setOptions(result.configOptions);
                setOperation({ kind: "idle" });
            }
        } catch (cause) {
            if (!lifetime.current.signal.aborted) {
                setOperation({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The selection could not be applied.",
                });
            }
        }
    };
    const busy = operation.kind === "sending" || operation.kind === "configuring";
    return (
        <section className="flex min-h-0 min-w-0 flex-1 animate-cloud-enter flex-col motion-reduce:animate-none">
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to Bot chat">
                    <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0">
                    <h1 className="truncate text-sm font-semibold">
                        {session.result.title || session.entry.title || "Local session"}
                    </h1>
                    <p className="truncate text-xs text-muted-foreground">
                        {session.agentRef} · {session.entry.directoryLabel}
                    </p>
                </div>
            </div>
            <div
                role="log"
                aria-label="Local session messages"
                className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6"
            >
                {session.result.history.status === "unavailable" && (
                    <p className="text-sm text-muted-foreground">This agent does not expose saved message history.</p>
                )}
                {messages.map((message) => (
                    <article
                        key={message.id}
                        aria-label={message.role === "user" ? "Your message" : "Agent response"}
                        className={`mx-auto max-w-3xl whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === "user" ? "bg-accent" : ""}`}
                    >
                        {message.text || (operation.kind === "sending" ? "Agent is thinking…" : "No text response.")}
                    </article>
                ))}
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                }}
                className="mx-auto w-full max-w-3xl space-y-3 p-4 sm:p-6"
            >
                <div className="flex flex-wrap gap-2">
                    {options
                        .filter(
                            (option) =>
                                ["model", "thought_level", "model_config"].includes(option.category) &&
                                option.type !== "boolean",
                        )
                        .map((option) => (
                            <div className="min-w-40 flex-1" key={option.id}>
                                <Select
                                    label={option.category === "model" ? "Model" : "Variant"}
                                    value={option.currentValue}
                                    options={option.values.map((value) => ({ value: value.value, label: value.name }))}
                                    disabled={busy}
                                    onValueChange={(value) => void configure(option, value)}
                                />
                            </div>
                        ))}
                </div>
                {operation.kind === "failed" && (
                    <p role="alert" className="text-sm text-destructive">
                        {operation.message}
                    </p>
                )}
                {operation.kind === "configuring" && (
                    <p role="status" className="text-xs text-muted-foreground">
                        Applying agent settings…
                    </p>
                )}
                {session.result.action === "preview" ? (
                    <p className="text-sm text-muted-foreground">
                        This agent provides a history preview but does not support continuing this session.
                    </p>
                ) : (
                    <div className="flex items-end gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm">
                        <Textarea
                            aria-label="Message local session"
                            placeholder="Continue this conversation…"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            disabled={busy}
                        />
                        <Button
                            type="submit"
                            size="icon"
                            aria-label="Send to local session"
                            disabled={busy || draft.trim() === ""}
                        >
                            <Send className="size-4" />
                        </Button>
                    </div>
                )}
            </form>
        </section>
    );
}
