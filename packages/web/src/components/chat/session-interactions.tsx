import type { SessionElicitationField } from "@moxt-ai/mobius-sdk";
import type { ElicitationResponseRequest } from "@moxt-ai/mobius-sdk/channel";
import { ExternalLink, HelpCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/cloud-button";
import { MortyAlert } from "@/components/ui/morty-alert";
import { textLinkClassName } from "@/components/ui/text-link";
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

/** Same surface language as `MortyAlert`: a 20px shell with a hairline border, 13px text, and a muted 14px icon. */
const interactionCardClassName =
    "min-w-0 w-full rounded-[20px] border-[0.5px] border-border bg-surface-elevated px-4 py-3 text-13 [overflow-wrap:anywhere]";
const interactionIconClassName = "mt-1 size-3.5 shrink-0 text-muted-foreground";
const interactionTitleClassName = "font-medium text-foreground";
/** Mirrors `Input`'s border, fill, radius, and focus ring so native inputs, selects, and textareas all match it. */
const nativeFieldClassName =
    "w-full min-w-0 rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-ring focus:outline-none! focus:shadow-[var(--focus-ring-shadow)] disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabelClassName = "grid gap-1.5 text-12 font-medium text-foreground";
const fieldDescriptionClassName = "font-normal text-muted-foreground";

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
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-13 text-foreground md:min-h-9">
                <input
                    className="size-4 accent-primary"
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
            <label className={fieldLabelClassName}>
                {field.title}
                <select
                    className={`min-h-11 font-normal md:min-h-9 ${nativeFieldClassName}`}
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
                {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
            </label>
        );
    }
    const numeric = field.type === "integer" || field.type === "number";
    if (field.type === "string" && field.multiline === true) {
        return (
            <label className={fieldLabelClassName}>
                {field.title}
                <textarea
                    className={`min-h-28 resize-y py-2 font-normal ${nativeFieldClassName}`}
                    defaultValue={
                        typeof value === "string" ? value : field.hasDefaultValue ? field.defaultStringValue : undefined
                    }
                    disabled={disabled}
                    maxLength={field.maximumLength.length > 0 ? Number(field.maximumLength) : undefined}
                    minLength={field.minimumLength.length > 0 ? Number(field.minimumLength) : undefined}
                    name={field.name}
                    placeholder={field.description}
                    required={field.required && Number(field.minimumLength) > 0}
                    rows={5}
                />
                {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
            </label>
        );
    }
    return (
        <label className={fieldLabelClassName}>
            {field.title}
            <input
                className={`h-9 min-h-11 font-normal md:min-h-9 ${nativeFieldClassName}`}
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
                required={field.required && (numeric || Number(field.minimumLength) > 0)}
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
            {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
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
        <section className={interactionCardClassName} role="alertdialog" aria-label="Agent permission request">
            <div className="flex items-start gap-2">
                <ShieldCheck aria-hidden="true" className={interactionIconClassName} />
                <div className="min-w-0 flex-1">
                    <p className={interactionTitleClassName}>{confirmed ? "Confirmed" : "Agent needs permission"}</p>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre rounded-md bg-muted p-3 font-mono text-12 leading-5">
                        {presentation.input}
                    </pre>
                    <section aria-label="Session working directory" className="mt-2 break-all text-12 leading-5">
                        <span className="text-muted-foreground">Session working directory: </span>
                        <code>{presentation.cwd}</code>
                    </section>
                    {presentation.locations.length > 0 && (
                        <section aria-label="Affected paths" className="mt-2 break-all font-mono text-12 leading-5">
                            {presentation.locations.map((location) => (
                                <p key={location}>{location}</p>
                            ))}
                        </section>
                    )}
                    <p className="mt-2 break-all text-12 leading-5 text-muted-foreground">{permission.title}</p>
                    {/* Pinned to the bottom of the bounded interaction scroller, above its edge fade, so long
                        details scroll behind the decisions instead of pushing them out of view on short screens. */}
                    <div className="sticky bottom-0 z-20 flex flex-wrap gap-2 bg-surface-elevated pt-3">
                        {presentation.options.map((option) => (
                            <Button
                                className="h-auto min-h-11 max-w-full whitespace-normal break-all py-2 md:min-h-9"
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
                                variant={option.allow ? "primary" : "outline"}
                            >
                                {option.label}
                            </Button>
                        ))}
                        <Button
                            className="h-auto min-h-11 max-w-full whitespace-normal break-all py-2 md:min-h-9"
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
        <section className={interactionCardClassName} role="dialog" aria-label="Agent information request">
            <div className="flex items-start gap-2">
                <HelpCircle aria-hidden="true" className={interactionIconClassName} />
                <div className="min-w-0 flex-1">
                    {answered ? (
                        <p className={interactionTitleClassName}>Asked</p>
                    ) : (
                        <p aria-label="Waiting for your answer" className={interactionTitleClassName} role="status">
                            Waiting for your answer
                        </p>
                    )}
                    <p className="mt-1 text-13 leading-5 text-foreground">{elicitation.message}</p>
                    {elicitation.mode === "url" ? (
                        <div className="mt-2.5">
                            <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-12 leading-5 text-foreground">
                                {externalUrl.length > 0 ? externalUrl : elicitation.url}
                            </code>
                            {answered && elicitation.state.action === "accept" ? (
                                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                    <span className="text-12 text-muted-foreground">
                                        Waiting for the agent to confirm completion…
                                    </span>
                                    {externalUrl.length > 0 && (
                                        <a
                                            className={`inline-flex min-h-11 items-center gap-1.5 rounded-sm text-13 font-medium outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70 md:min-h-9 ${textLinkClassName}`}
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
                                            className="min-h-11 md:min-h-9"
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
                                        className="min-h-11 md:min-h-9"
                                        disabled={busy || answered}
                                        onClick={() => cancel("decline")}
                                        size="sm"
                                        variant="outline"
                                    >
                                        Decline
                                    </Button>
                                    <Button
                                        className="min-h-11 md:min-h-9"
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
                                    className="min-h-11 md:min-h-9"
                                    disabled={busy || answered}
                                    size="sm"
                                    type="submit"
                                >
                                    Continue
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-9"
                                    disabled={busy || answered}
                                    onClick={() => cancel("decline")}
                                    size="sm"
                                    variant="outline"
                                >
                                    Decline
                                </Button>
                                <Button
                                    className="min-h-11 md:min-h-9"
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
            {error.length > 0 && <MortyAlert>{error}</MortyAlert>}
        </div>
    );
}
