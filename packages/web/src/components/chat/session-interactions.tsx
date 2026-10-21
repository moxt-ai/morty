import type { SessionElicitationField } from "@moxt-ai/mobius-sdk";
import type { ElicitationResponseRequest } from "@moxt-ai/mobius-sdk/channel";
import { ExternalLink, HelpCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { encodeElicitationForm, readMultiselectDefaults } from "@/services/chat/elicitation-form";
import { permissionPresentation } from "@/view-models/chat/session-interaction-store";
import type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "@/view-models/chat/session-pane-types";

export type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "@/view-models/chat/session-pane-types";

function safeExternalUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") {
            return url.toString();
        }
    } catch {}
    return "";
}

function FieldControl({
    disabled,
    field,
    value,
}: {
    readonly disabled: boolean;
    readonly field: SessionElicitationField;
    readonly value: unknown;
}) {
    if (field.type === "boolean") {
        return (
            <label className="flex min-h-11 items-center gap-2 rounded-md border-[0.5px] border-black/9 px-3 text-xs text-[#454959] md:min-h-10">
                <input
                    defaultChecked={
                        typeof value === "boolean" ? value : field.hasDefaultValue && field.defaultBooleanValue
                    }
                    disabled={disabled}
                    name={field.name}
                    type="checkbox"
                />
                {field.title}
            </label>
        );
    }
    if (field.type === "select" || field.type === "multiselect") {
        return (
            <label className="grid gap-1.5 text-[11px] font-medium text-[#555c68]">
                {field.title}
                <select
                    className="min-h-11 rounded-md border-[0.5px] border-black/12 bg-white px-2.5 text-base font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-10 md:text-xs"
                    defaultValue={
                        field.type === "multiselect" && Array.isArray(value)
                            ? value.filter((entry): entry is string => typeof entry === "string")
                            : typeof value === "string"
                              ? value
                              : field.type === "multiselect"
                                ? readMultiselectDefaults(field)
                                : field.hasDefaultValue
                                  ? field.defaultStringValue
                                  : undefined
                    }
                    disabled={disabled}
                    multiple={field.type === "multiselect"}
                    name={field.name}
                    required={field.required}
                >
                    {!field.required && field.type === "select" && <option value="">Not selected</option>}
                    {field.options.map((option) => (
                        <option key={option.value} title={option.description} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                {field.description.length > 0 && (
                    <span className="font-normal text-muted-foreground">{field.description}</span>
                )}
            </label>
        );
    }
    const numeric = field.type === "integer" || field.type === "number";
    return (
        <label className="grid gap-1.5 text-[11px] font-medium text-[#555c68]">
            {field.title}
            <input
                className="min-h-11 rounded-md border-[0.5px] border-black/12 bg-white px-3 text-base font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-10 md:text-xs"
                defaultValue={
                    typeof value === "string" || typeof value === "number"
                        ? value
                        : field.hasDefaultValue
                          ? numeric
                              ? field.defaultNumberValue
                              : field.defaultStringValue
                          : undefined
                }
                disabled={disabled}
                max={field.maximum.length > 0 ? field.maximum : undefined}
                maxLength={!numeric && field.maximumLength.length > 0 ? Number(field.maximumLength) : undefined}
                min={field.minimum.length > 0 ? field.minimum : undefined}
                minLength={!numeric && field.minimumLength.length > 0 ? Number(field.minimumLength) : undefined}
                name={field.name}
                pattern={field.pattern.length > 0 ? field.pattern : undefined}
                placeholder={field.description}
                required={field.required}
                step={field.type === "integer" ? 1 : "any"}
                type={
                    numeric
                        ? "number"
                        : field.format === "email"
                          ? "email"
                          : field.format === "uri"
                            ? "url"
                            : field.format === "date"
                              ? "date"
                              : field.format === "date-time"
                                ? "datetime-local"
                                : "text"
                }
            />
            {field.description.length > 0 && (
                <span className="font-normal text-muted-foreground">{field.description}</span>
            )}
        </label>
    );
}

function elicitationAnswers(elicitation: ElicitationInteraction): Readonly<Record<string, unknown>> {
    if (elicitation.state.kind === "pending" || elicitation.state.content.length === 0) {
        return {};
    }
    try {
        const decoded: unknown = JSON.parse(elicitation.state.content);
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
            return {};
        }
        return Object.fromEntries(Object.entries(decoded));
    } catch {
        return {};
    }
}

function PermissionCard({
    busy,
    permission,
    respond,
    stop,
}: {
    readonly busy: boolean;
    readonly permission: PermissionInteraction;
    readonly stop: () => void;
    readonly respond: (response: PermissionInteractionResponse) => void;
}) {
    const confirmed = permission.state.kind !== "pending";
    const presentation = permissionPresentation(permission);
    return (
        <section
            className="w-full rounded-lg border-[0.5px] border-input bg-white px-4 pt-5 pb-4 text-sm"
            role="alertdialog"
            aria-label="Agent permission request"
        >
            <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#fff3c4] text-[#8a5a00]">
                    <ShieldCheck className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-base leading-6 font-semibold text-foreground">
                        {confirmed ? "Confirmed" : "Agent needs permission"}
                    </p>
                    <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-5">
                        {presentation.input}
                    </pre>
                    <section aria-label="Session working directory" className="mt-2 break-all text-xs leading-5">
                        <span className="text-muted-foreground">Session working directory: </span>
                        <code>{presentation.cwd}</code>
                    </section>
                    {presentation.locations.length > 0 && (
                        <section aria-label="Affected paths" className="mt-2 break-all font-mono text-xs leading-5">
                            {presentation.locations.map((location) => (
                                <p key={location}>{location}</p>
                            ))}
                        </section>
                    )}
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{permission.title}</p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                        {presentation.options.map((option) => (
                            <Button
                                className="min-h-11 md:min-h-10"
                                disabled={busy || confirmed}
                                key={option.optionId}
                                onClick={() => {
                                    respond({
                                        interactionId: permission.interactionId,
                                        optionId: option.optionId,
                                        outcome: "selected",
                                        sessionId: permission.sessionId,
                                    });
                                }}
                                size="sm"
                                variant={option.allow ? "default" : "outline"}
                            >
                                {option.label}
                            </Button>
                        ))}
                        <Button
                            className="min-h-11 md:min-h-10"
                            disabled={busy || confirmed}
                            onClick={stop}
                            size="sm"
                            variant="ghost"
                        >
                            Stop turn
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    );
}

function ElicitationCard({
    busy,
    elicitation,
    respond,
}: {
    readonly busy: boolean;
    readonly elicitation: ElicitationInteraction;
    readonly respond: (response: ElicitationInteractionResponse) => void;
}) {
    const externalUrl = safeExternalUrl(elicitation.url);
    const answered = elicitation.state.kind !== "pending";
    const answers = elicitationAnswers(elicitation);
    const cancel = (action: ElicitationResponseRequest["action"]): void => {
        respond({
            action,
            content: "",
            interactionId: elicitation.interactionId,
            sessionId: elicitation.sessionId,
        });
    };

    return (
        <section
            className="w-full rounded-lg border-[0.5px] border-input bg-white px-4 pt-5 pb-4 text-sm"
            role="dialog"
            aria-label="Agent information request"
        >
            <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#e5edff] text-[#3159a6]">
                    <HelpCircle className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-base leading-6 font-semibold text-foreground">
                        {answered ? "Asked" : "Agent needs input"}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-foreground">{elicitation.message}</p>
                    {elicitation.mode === "url" ? (
                        <div className="mt-2.5">
                            <code className="block break-all rounded-lg border-[0.5px] border-[#2f6feb]/15 bg-white/70 px-2.5 py-2 text-[10px] leading-4 text-[#435f8c]">
                                {externalUrl.length > 0 ? externalUrl : elicitation.url}
                            </code>
                            {answered && elicitation.state.action === "accept" ? (
                                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                    <span className="text-[11px] font-medium text-[#435f8c]">
                                        Waiting for the agent to confirm completion…
                                    </span>
                                    {externalUrl.length > 0 && (
                                        <a
                                            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-[#3159a6] outline-none hover:bg-[#e5edff] focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-10"
                                            href={externalUrl}
                                            rel="noreferrer"
                                            target="_blank"
                                        >
                                            Open again <ExternalLink className="size-3.5" />
                                        </a>
                                    )}
                                </div>
                            ) : (
                                <div className="mt-2.5 flex flex-wrap gap-2">
                                    {externalUrl.length > 0 && (
                                        <Button
                                            className="min-h-11 md:min-h-10"
                                            disabled={busy || answered}
                                            onClick={() => {
                                                window.open(externalUrl, "_blank", "noopener,noreferrer");
                                                respond({
                                                    action: "accept",
                                                    content: "",
                                                    interactionId: elicitation.interactionId,
                                                    sessionId: elicitation.sessionId,
                                                });
                                            }}
                                            size="sm"
                                        >
                                            Open page <ExternalLink className="size-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        className="min-h-11 md:min-h-10"
                                        disabled={busy || answered}
                                        onClick={() => cancel("decline")}
                                        size="sm"
                                        variant="outline"
                                    >
                                        Decline
                                    </Button>
                                    <Button
                                        className="min-h-11 md:min-h-10"
                                        disabled={busy || answered}
                                        onClick={() => cancel("cancel")}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <form
                            className="mt-3 grid gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                respond({
                                    action: "accept",
                                    content: encodeElicitationForm(
                                        new FormData(event.currentTarget),
                                        elicitation.fields,
                                    ),
                                    interactionId: elicitation.interactionId,
                                    sessionId: elicitation.sessionId,
                                });
                            }}
                        >
                            {elicitation.fields.map((field) => (
                                <FieldControl
                                    disabled={busy || answered}
                                    field={field}
                                    key={field.name}
                                    value={Reflect.get(answers, field.name)}
                                />
                            ))}
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    className="min-h-11 md:min-h-10"
                                    disabled={busy || answered}
                                    size="sm"
                                    type="submit"
                                >
                                    Continue
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-10"
                                    disabled={busy || answered}
                                    onClick={() => cancel("decline")}
                                    size="sm"
                                    variant="outline"
                                >
                                    Decline
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-10"
                                    disabled={busy || answered}
                                    onClick={() => cancel("cancel")}
                                    size="sm"
                                    variant="ghost"
                                >
                                    Cancel
                                </Button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </section>
    );
}

export function SessionInteractionCards({
    elicitations,
    permissions,
    onElicitationResponse,
    onPermissionResponse,
    onStop,
    busyInteractionIds,
    error,
}: {
    readonly elicitations: readonly ElicitationInteraction[];
    readonly permissions: readonly PermissionInteraction[];
    readonly onStop: () => void;
    readonly onElicitationResponse: (response: ElicitationInteractionResponse) => void;
    readonly onPermissionResponse: (response: PermissionInteractionResponse) => void;
    readonly busyInteractionIds: ReadonlySet<string>;
    readonly error: string;
}) {
    if (permissions.length === 0 && elicitations.length === 0) {
        return null;
    }
    return (
        <div className="grid w-full gap-3">
            {permissions.map((permission) => (
                <PermissionCard
                    busy={busyInteractionIds.has(permission.interactionId)}
                    key={permission.interactionId}
                    permission={permission}
                    respond={onPermissionResponse}
                    stop={onStop}
                />
            ))}
            {elicitations.map((elicitation) => (
                <ElicitationCard
                    busy={busyInteractionIds.has(elicitation.interactionId)}
                    elicitation={elicitation}
                    key={elicitation.interactionId}
                    respond={onElicitationResponse}
                />
            ))}
            {error.length > 0 && (
                <p role="alert" className="text-xs text-destructive">
                    {error}
                </p>
            )}
        </div>
    );
}
