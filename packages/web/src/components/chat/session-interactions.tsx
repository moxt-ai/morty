import type { SessionElicitationField } from "@moxt-ai/mobius-sdk";
import type { ElicitationResponseRequest } from "@moxt-ai/mobius-sdk/channel";
import { ArrowUpRight, ChevronDown, HelpCircle, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/cloud-button";
import { MortyAlert } from "@/components/ui/morty-alert";
import { Select as OptionSelect } from "@/components/ui/option-select";
import { textLinkClassName } from "@/components/ui/text-link";
import { cn } from "@/lib/utils";
import { encodeElicitationForm, readMultiselectDefaults } from "@/services/chat/elicitation-form";
import { permissionPresentation } from "@/view-models/chat/session-interaction-store";
import type {
    ElicitationInteraction,
    ElicitationInteractionResponse,
    PermissionInteraction,
    PermissionInteractionResponse,
} from "@/view-models/chat/session-pane-types";
import {
    agentThinkStepChevronClassName,
    agentThinkStepInlineLabelClassName,
    agentThinkStepTitleClassName,
    agentThinkStepTriggerClassName,
} from "./tools/tool-call-status";

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
    "min-w-0 w-full rounded-[20px] border-[0.5px] border-border bg-surface-elevated px-4 py-4 text-13 [overflow-wrap:anywhere]";
const interactionIconClassName = "mt-[3px] size-4 shrink-0 text-muted-foreground";
const interactionTitleClassName = "text-15 font-semibold text-foreground";
const interactionMonoClassName =
    "mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-12 leading-5";
/** Mirrors `Input`'s border, fill, radius, and focus ring so native inputs, selects, and textareas all match it. */
const nativeFieldClassName =
    "w-full min-w-0 rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-ring focus:outline-none! focus:shadow-[var(--focus-ring-shadow)] disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabelClassName = "grid gap-1.5 text-12 font-medium text-foreground";
const fieldDescriptionClassName = "font-normal text-muted-foreground";

/** The library has no checkbox primitive, so booleans use the component library's segmented aria-pressed button idiom. */
function BooleanFieldControl({
    disabled,
    field,
    value,
}: {
    readonly disabled: boolean;
    readonly field: SessionElicitationField;
    readonly value: unknown;
}) {
    const [on, setOn] = useState(
        typeof value === "boolean" ? value : field.hasDefaultValue && field.defaultBooleanValue,
    );
    return (
        <div className={fieldLabelClassName}>
            <span>{field.title}</span>
            {on && <input name={field.name} type="hidden" value="on" />}
            <fieldset aria-label={field.title} className="m-0 min-w-0 border-0 p-0">
                <ButtonGroup orientation="horizontal" size="sm">
                    <Button
                        aria-pressed={on}
                        className="min-h-11 rounded-full! md:min-h-9"
                        disabled={disabled}
                        onClick={() => setOn(true)}
                        size="sm"
                        type="button"
                        variant={on ? "primary" : "outline"}
                    >
                        Yes
                    </Button>
                    <Button
                        aria-pressed={!on}
                        className="min-h-11 rounded-full! md:min-h-9"
                        disabled={disabled}
                        onClick={() => setOn(false)}
                        size="sm"
                        type="button"
                        variant={!on ? "primary" : "outline"}
                    >
                        No
                    </Button>
                </ButtonGroup>
            </fieldset>
            {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
        </div>
    );
}

/** Controlled library Select; a hidden input keeps the FormData contract `encodeElicitationForm` reads. */
function SelectFieldControl({
    disabled,
    field,
    value,
}: {
    readonly disabled: boolean;
    readonly field: SessionElicitationField;
    readonly value: unknown;
}) {
    const [selected, setSelected] = useState(
        typeof value === "string" ? value : field.hasDefaultValue ? field.defaultStringValue : "",
    );
    return (
        <div className={fieldLabelClassName}>
            <span>{field.title}</span>
            <input name={field.name} type="hidden" value={selected} />
            <OptionSelect
                className="min-h-11 rounded-full md:min-h-9"
                disabled={disabled}
                label={field.title}
                onValueChange={setSelected}
                options={field.options.map((option) =>
                    option.description.length > 0
                        ? { label: option.label, title: option.description, value: option.value }
                        : { label: option.label, value: option.value },
                )}
                placeholder="Not selected"
                value={selected}
            />
            {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
        </div>
    );
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
        return <BooleanFieldControl disabled={disabled} field={field} value={value} />;
    }
    if (field.type === "select") {
        return <SelectFieldControl disabled={disabled} field={field} value={value} />;
    }
    if (field.type === "multiselect") {
        return (
            <label className={fieldLabelClassName}>
                {field.title}
                <select
                    className={cn(nativeFieldClassName, "min-h-11 rounded-full font-normal md:min-h-9")}
                    defaultValue={
                        Array.isArray(value)
                            ? value.filter((entry): entry is string => typeof entry === "string")
                            : readMultiselectDefaults(field)
                    }
                    disabled={disabled}
                    multiple
                    name={field.name}
                    required={field.required}
                >
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
                    className={`min-h-20 resize-y py-2 font-normal ${nativeFieldClassName}`}
                    defaultValue={
                        typeof value === "string" ? value : field.hasDefaultValue ? field.defaultStringValue : undefined
                    }
                    disabled={disabled}
                    maxLength={field.maximumLength.length > 0 ? Number(field.maximumLength) : undefined}
                    minLength={field.minimumLength.length > 0 ? Number(field.minimumLength) : undefined}
                    name={field.name}
                    placeholder={field.description}
                    required={field.required && Number(field.minimumLength) > 0}
                    rows={3}
                />
                {field.description.length > 0 && <span className={fieldDescriptionClassName}>{field.description}</span>}
            </label>
        );
    }
    return (
        <label className={fieldLabelClassName}>
            {field.title}
            <input
                className={cn(nativeFieldClassName, "min-h-11 rounded-full font-normal md:min-h-9")}
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

/** Generic affirmatives/negatives carry no scope, so the label is derived from the option kind instead. */
const genericAnswerNames = new Set(["n", "no", "y", "yes"]);

type PermissionOption = PermissionInteraction["options"][number];

function scopeLabel(kind: PermissionOption["kind"]): string {
    switch (kind) {
        case "allow_once":
            return "Allow";
        case "allow_always":
            return "Allow for this session";
        case "reject_once":
            return "Deny";
        case "reject_always":
            return "Deny for this session";
        default: {
            const unexpected: never = kind;
            throw new Error(`Unsupported permission option: ${unexpected}`);
        }
    }
}

function optionLabel(option: PermissionOption): string {
    if (genericAnswerNames.has(option.name.trim().toLowerCase())) {
        return scopeLabel(option.kind);
    }
    const lower = option.name.toLowerCase();
    switch (option.kind) {
        case "allow_once":
        case "allow_always":
            return lower.startsWith("allow") ? option.name : `Allow: ${option.name}`;
        case "reject_once":
        case "reject_always":
            return lower.startsWith("deny") || lower.startsWith("reject") ? option.name : `Deny: ${option.name}`;
        default: {
            const unexpected: never = option.kind;
            throw new Error(`Unsupported permission option: ${unexpected}`);
        }
    }
}

function isAllowKind(kind: PermissionOption["kind"]): boolean {
    return kind === "allow_once" || kind === "allow_always";
}

/** The shell command when this is an `execute` request carrying one; raw JSON stays the fallback for every other tool shape. */
function executeCommand(permission: PermissionInteraction): string | undefined {
    if (permission.toolKind !== "execute") {
        return undefined;
    }
    const rawInput: unknown = permission.details?.rawInput;
    if (typeof rawInput !== "object" || rawInput === null || !("command" in rawInput)) {
        return undefined;
    }
    const command: unknown = rawInput.command;
    return typeof command === "string" && command.length > 0 ? command : undefined;
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
    const presentation = permissionPresentation(permission);
    const command = executeCommand(permission);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const detailsContentId = useId();
    const decidedOptionId = permission.state.kind === "pending" ? undefined : permission.state.optionId;
    if (decidedOptionId !== undefined) {
        const chosen = permission.options.find((option) => option.optionId === decidedOptionId);
        return (
            <section className={interactionCardClassName} role="alertdialog" aria-label="Agent permission request">
                <div className="flex items-start gap-2">
                    <ShieldCheck aria-hidden="true" className={interactionIconClassName} />
                    <div className="min-w-0 flex-1">
                        <p className={interactionTitleClassName}>Confirmed</p>
                        <p className="mt-1 break-all text-13 leading-5 text-foreground">{permission.title}</p>
                        {chosen !== undefined && (
                            <dl className="mt-2 grid gap-1 text-12 leading-5">
                                <div className="flex flex-wrap gap-x-1.5">
                                    <dt className="text-muted-foreground">Decision:</dt>
                                    <dd className="break-all font-medium text-foreground">{optionLabel(chosen)}</dd>
                                </div>
                            </dl>
                        )}
                    </div>
                </div>
            </section>
        );
    }
    const locationsLabel =
        presentation.locations.length === 1 ? "1 affected path" : `${presentation.locations.length} affected paths`;
    const disclosureLabel =
        presentation.locations.length > 0
            ? `Details · ${locationsLabel}`
            : command === undefined
              ? "Details · working directory"
              : "Details · full input";
    return (
        <section className={interactionCardClassName} role="alertdialog" aria-label="Agent permission request">
            <div className="flex items-start gap-2">
                <ShieldCheck aria-hidden="true" className={interactionIconClassName} />
                <div className="min-w-0 flex-1">
                    <p className={interactionTitleClassName}>Agent needs permission</p>
                    <p className="mt-1 break-all text-13 leading-5 text-foreground">{permission.title}</p>
                    {permission.details === undefined ? (
                        <p className="mt-3 rounded-md bg-muted p-3 text-12 leading-5 text-muted-foreground">
                            The agent sent no details with this request.
                        </p>
                    ) : command === undefined ? (
                        <pre className={interactionMonoClassName}>{presentation.input}</pre>
                    ) : (
                        <pre className={interactionMonoClassName}>
                            <span className="text-muted-foreground">{permission.details.cwd} $ </span>
                            {command}
                        </pre>
                    )}
                    {permission.details !== undefined && (
                        <div className="mt-3 min-w-0">
                            <button
                                aria-controls={detailsContentId}
                                aria-expanded={detailsOpen}
                                className={agentThinkStepTriggerClassName}
                                onClick={() => setDetailsOpen(!detailsOpen)}
                                type="button"
                            >
                                <span className={agentThinkStepInlineLabelClassName}>
                                    <span className={agentThinkStepTitleClassName}>{disclosureLabel}</span>
                                    <ChevronDown
                                        aria-hidden="true"
                                        className={cn(
                                            agentThinkStepChevronClassName,
                                            detailsOpen && "visible rotate-0",
                                        )}
                                    />
                                </span>
                            </button>
                            {detailsOpen && (
                                <div className="mb-2 grid gap-2 text-12 leading-5" id={detailsContentId}>
                                    {command === undefined && (
                                        <p className="break-all">
                                            <span className="text-muted-foreground">Session working directory: </span>
                                            <code>{presentation.cwd}</code>
                                        </p>
                                    )}
                                    {presentation.locations.length > 0 && (
                                        <section aria-label="Affected paths" className="break-all font-mono">
                                            {presentation.locations.map((location) => (
                                                <p key={location}>{location}</p>
                                            ))}
                                        </section>
                                    )}
                                    {command !== undefined && (
                                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono">
                                            {presentation.input}
                                        </pre>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {/* Pinned to the bottom of the bounded interaction scroller, above its edge fade, so long
                        details scroll behind the decisions instead of pushing them out of view on short screens. */}
                    <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 bg-surface-elevated pt-3">
                        {permission.options.map((option) => (
                            <Button
                                className="h-auto min-h-11 max-w-full whitespace-normal break-all py-2 md:min-h-9"
                                disabled={busy}
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
                                variant={isAllowKind(option.kind) ? "primary" : "outline"}
                            >
                                {optionLabel(option)}
                            </Button>
                        ))}
                        <Button
                            className="h-auto min-h-11 max-w-full whitespace-normal break-all py-2 md:min-h-9"
                            disabled={busy}
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

function formatAnswerValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    if (typeof value === "boolean") {
        return value ? "yes" : "no";
    }
    return String(value);
}

/** Outcome of a decided information request: the answered values, or a one-word note for decline/cancel. */
type AnsweredOutcome =
    | { readonly kind: "answers"; readonly parts: readonly { readonly title: string; readonly value: string }[] }
    | { readonly kind: "note"; readonly text: string };

function answeredOutcome(elicitation: ElicitationInteraction): AnsweredOutcome {
    const state = elicitation.state;
    if (state.kind === "pending") {
        return { kind: "note", text: "Accepted" };
    }
    if (state.action === "decline") {
        return { kind: "note", text: "Declined" };
    }
    if (state.action === "cancel") {
        return { kind: "note", text: "Cancelled" };
    }
    const answers = elicitationAnswers(elicitation);
    const parts = elicitation.fields
        .filter((field) => Reflect.has(answers, field.name))
        .map((field) => ({ title: field.title, value: formatAnswerValue(Reflect.get(answers, field.name)) }));
    return parts.length > 0 ? { kind: "answers", parts } : { kind: "note", text: "Accepted" };
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
    const [missingRequiredTitle, setMissingRequiredTitle] = useState("");
    const cancel = (action: ElicitationResponseRequest["action"]): void => {
        respond({
            action,
            content: "",
            interactionId: elicitation.interactionId,
            sessionId: elicitation.sessionId,
        });
    };
    if (answered && elicitation.mode === "form") {
        const outcome = answeredOutcome(elicitation);
        return (
            <section className={interactionCardClassName} role="dialog" aria-label="Agent information request">
                <div className="flex items-start gap-2">
                    <HelpCircle aria-hidden="true" className={interactionIconClassName} />
                    <div className="min-w-0 flex-1">
                        <p className={interactionTitleClassName}>Asked</p>
                        <p className="mt-1 break-all text-13 leading-5 text-foreground">{elicitation.message}</p>
                        {outcome.kind === "answers" ? (
                            <dl className="mt-2 grid gap-1 text-12 leading-5">
                                {outcome.parts.map((part) => (
                                    <div className="flex flex-wrap gap-x-1.5" key={part.title}>
                                        <dt className="text-muted-foreground">{part.title}:</dt>
                                        <dd className="break-all font-medium text-foreground">{part.value}</dd>
                                    </div>
                                ))}
                            </dl>
                        ) : (
                            <p className="mt-1 text-12 leading-5 text-muted-foreground">{outcome.text}</p>
                        )}
                    </div>
                </div>
            </section>
        );
    }

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
                                            className={`inline-flex min-h-11 items-center gap-1 rounded-sm text-13 font-medium outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70 md:min-h-9 ${textLinkClassName}`}
                                            href={externalUrl}
                                            rel="noreferrer"
                                            target="_blank"
                                        >
                                            Open again <ArrowUpRight aria-hidden="true" className="size-3.5" />
                                        </a>
                                    )}
                                </div>
                            ) : (
                                <div className="mt-2.5 flex flex-wrap gap-2">
                                    {externalUrl.length > 0 && (
                                        <Button
                                            className="gap-[6px] min-h-11 md:min-h-9"
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
                                            Open page <ArrowUpRight aria-hidden="true" className="size-3.5" />
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
                                const formData = new FormData(event.currentTarget);
                                // The library Select is not a native form control, so its required gate is checked here.
                                const missing = elicitation.fields.find(
                                    (field) =>
                                        field.type === "select" && field.required && formData.get(field.name) === "",
                                );
                                if (missing !== undefined) {
                                    setMissingRequiredTitle(missing.title);
                                    return;
                                }
                                setMissingRequiredTitle("");
                                respond({
                                    action: "accept",
                                    content: encodeElicitationForm(formData, elicitation.fields),
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
                            {missingRequiredTitle.length > 0 && (
                                <MortyAlert>Select an option for {missingRequiredTitle}.</MortyAlert>
                            )}
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
