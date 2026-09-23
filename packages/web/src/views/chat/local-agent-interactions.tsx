import type { SessionElicitationRequestedEvent, SessionPermissionRequestedEvent } from "@moxt-ai/mobius-protocol";
import type { Dispatch, SetStateAction } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";

export type PendingInteraction =
    | { readonly kind: "permission"; readonly request: SessionPermissionRequestedEvent }
    | { readonly kind: "elicitation"; readonly request: SessionElicitationRequestedEvent };

export function LocalAgentInteractions({
    interaction,
    elicitationValues,
    setElicitationValues,
    answerPermission,
    answerElicitation,
}: {
    readonly interaction: PendingInteraction | null;
    readonly elicitationValues: Readonly<Record<string, string>>;
    readonly setElicitationValues: Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
    readonly answerPermission: (request: SessionPermissionRequestedEvent, optionId: string) => Promise<void>;
    readonly answerElicitation: (
        request: SessionElicitationRequestedEvent,
        action: "accept" | "cancel" | "decline",
    ) => Promise<void>;
}) {
    return (
        <>
            {interaction?.kind === "permission" && (
                <fieldset
                    aria-label="Agent permission request"
                    className="mx-auto max-w-3xl rounded-xl border border-border bg-card p-4"
                >
                    <p className="font-medium">{interaction.request.title}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {interaction.request.options.map((option) => (
                            <Button
                                key={option.optionId}
                                onClick={() => void answerPermission(interaction.request, option.optionId)}
                                type="button"
                                variant="outline"
                            >
                                {option.name}
                            </Button>
                        ))}
                    </div>
                </fieldset>
            )}
            {interaction?.kind === "elicitation" && (
                <fieldset
                    aria-label="Agent input request"
                    className="mx-auto max-w-3xl space-y-3 rounded-xl border border-border bg-card p-4"
                >
                    <p className="font-medium">{interaction.request.message}</p>
                    {interaction.request.mode === "url" && (
                        <a className="underline" href={interaction.request.url} rel="noreferrer" target="_blank">
                            Open authorization page
                        </a>
                    )}
                    {interaction.request.mode === "form" &&
                        interaction.request.fields.map((field) => (
                            <div className="block text-sm" key={field.name}>
                                <label className="mb-1 block" htmlFor={`elicitation-${field.name}`}>
                                    {field.title}
                                </label>
                                {field.type === "boolean" ? (
                                    <input
                                        checked={elicitationValues[field.name] === "true"}
                                        id={`elicitation-${field.name}`}
                                        onChange={(event) =>
                                            setElicitationValues((current) => ({
                                                ...current,
                                                [field.name]: String(event.target.checked),
                                            }))
                                        }
                                        type="checkbox"
                                    />
                                ) : field.type === "select" ? (
                                    <select
                                        className="w-full rounded border border-border bg-background p-2"
                                        id={`elicitation-${field.name}`}
                                        onChange={(event) =>
                                            setElicitationValues((current) => ({
                                                ...current,
                                                [field.name]: event.target.value,
                                            }))
                                        }
                                        value={elicitationValues[field.name] ?? ""}
                                    >
                                        <option value="">Choose…</option>
                                        {field.options.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        className="w-full rounded border border-border bg-background p-2"
                                        id={`elicitation-${field.name}`}
                                        onChange={(event) =>
                                            setElicitationValues((current) => ({
                                                ...current,
                                                [field.name]: event.target.value,
                                            }))
                                        }
                                        type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                                        value={elicitationValues[field.name] ?? ""}
                                    />
                                )}
                                {field.description && (
                                    <span className="block text-xs text-muted-foreground">{field.description}</span>
                                )}
                            </div>
                        ))}
                    <div className="flex gap-2">
                        <Button onClick={() => void answerElicitation(interaction.request, "accept")} type="button">
                            Continue
                        </Button>
                        <Button
                            onClick={() => void answerElicitation(interaction.request, "decline")}
                            type="button"
                            variant="outline"
                        >
                            Decline
                        </Button>
                    </div>
                </fieldset>
            )}
        </>
    );
}
