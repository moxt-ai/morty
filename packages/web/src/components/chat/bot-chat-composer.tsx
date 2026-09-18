import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";
import { FileText, LoaderCircle, Paperclip, Plus, Send, Square, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import {
    AttachmentReadError,
    ReadPromptImage,
    ReadPromptResource,
    readPromptAttachment,
} from "../../services/chat/attachment-reader.ts";
import { Button } from "../ui/cloud-button.tsx";
import { Textarea } from "../ui/textarea.tsx";

export type ComposerAttachment =
    | { readonly kind: "image"; readonly image: PromptImage }
    | { readonly kind: "resource"; readonly resource: PromptResource };

function attachmentName(attachment: ComposerAttachment): string {
    return attachment.kind === "image" ? attachment.image.name : attachment.resource.name;
}

function AttachmentPreview({
    attachment,
    onRemove,
}: {
    readonly attachment: ComposerAttachment;
    readonly onRemove: () => void;
}) {
    const name = attachmentName(attachment);
    return (
        <li className="group/attachment relative flex h-[60px] max-w-52 items-center gap-2 rounded-xl border border-border bg-surface-subtle p-2 pr-8 text-xs text-copy-secondary">
            {attachment.kind === "image" ? (
                <img
                    alt=""
                    className="size-11 rounded-lg object-cover"
                    src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`}
                />
            ) : (
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-white text-muted-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                    <FileText aria-hidden="true" className="size-5" />
                </span>
            )}
            <span className="min-w-0 truncate" title={name}>
                {name}
            </span>
            <button
                aria-label={`Remove ${name}`}
                className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-black/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                onClick={onRemove}
                type="button"
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </li>
    );
}

export function BotChatComposer({
    attachments,
    children,
    disabled,
    draft,
    error,
    onAttachmentsChange,
    onDraftChange,
    onStop,
    onSubmit,
    outputState,
    messageLabel = "Message",
    placeholder = "Ask me anything",
    submitLabel = "Send message",
    submitDisabled,
}: {
    readonly attachments: readonly ComposerAttachment[];
    readonly children: ReactNode;
    readonly disabled: boolean;
    readonly draft: string;
    readonly error: string;
    readonly onAttachmentsChange: (attachments: readonly ComposerAttachment[]) => void;
    readonly onDraftChange: (draft: string) => void;
    readonly onStop: () => void;
    readonly onSubmit: () => void;
    readonly outputState: "idle" | "sending" | "running" | "stopping";
    readonly messageLabel?: string;
    readonly placeholder?: string;
    readonly submitLabel?: string;
    readonly submitDisabled: boolean;
}) {
    const fileInput = useRef<HTMLInputElement>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [attachmentState, setAttachmentState] = useState<
        { readonly kind: "idle" } | { readonly kind: "reading" } | { readonly kind: "failed"; readonly message: string }
    >({ kind: "idle" });

    const attachFiles = (files: FileList): void => {
        setAttachmentState({ kind: "reading" });
        void Promise.all(
            Array.from(files)
                .slice(0, Math.max(0, 8 - attachments.length))
                .map(readPromptAttachment),
        )
            .then((read) => {
                const added = read.map((attachment): ComposerAttachment => {
                    if (attachment instanceof ReadPromptImage) {
                        return { image: attachment.image, kind: "image" };
                    }
                    if (attachment instanceof ReadPromptResource) {
                        return { kind: "resource", resource: attachment.resource };
                    }
                    throw new AttachmentReadError(
                        "attachment_type_unsupported",
                        "The selected attachment is unsupported.",
                    );
                });
                onAttachmentsChange([...attachments, ...added]);
                setAttachmentState({ kind: "idle" });
            })
            .catch((cause: unknown) => {
                setAttachmentState({
                    kind: "failed",
                    message:
                        cause instanceof AttachmentReadError
                            ? cause.message
                            : "The selected attachment could not be read.",
                });
            })
            .finally(() => {
                if (fileInput.current !== null) {
                    fileInput.current.value = "";
                }
            });
    };

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (!submitDisabled) {
            onSubmit();
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === "Enter" && event.ctrlKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.setRangeText(
                "\n",
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
                "end",
            );
            onDraftChange(event.currentTarget.value);
            return;
        }
        if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.nativeEvent.isComposing
        ) {
            return;
        }
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
    };

    return (
        <form className="mx-auto mt-5 mb-5 w-full max-w-[976px] shrink-0 px-4 sm:mt-6 sm:mb-6" onSubmit={submit}>
            {(error.length > 0 || attachmentState.kind === "failed") && (
                <p className="mb-2 px-1 text-sm text-destructive" role="alert">
                    {error.length > 0 ? error : attachmentState.kind === "failed" ? attachmentState.message : ""}
                </p>
            )}
            <div className="rounded-[24px] border border-[#d7dcdf] bg-white px-3 pt-3 pb-2.5 shadow-[0_5px_18px_rgba(23,30,36,0.04)] transition-[border-color,box-shadow] focus-within:border-[#b9c0c5] focus-within:shadow-[0_7px_22px_rgba(23,30,36,0.06)] sm:min-h-[148px] sm:px-5 sm:pt-4 sm:pb-3">
                {attachments.length > 0 && (
                    <ul aria-label="Attachments" className="mb-2 flex list-none flex-wrap gap-2 p-0">
                        {attachments.map((attachment, index) => (
                            <AttachmentPreview
                                attachment={attachment}
                                key={`${attachment.kind}:${attachmentName(attachment)}:${index.toString()}`}
                                onRemove={() => onAttachmentsChange(attachments.filter((_, item) => item !== index))}
                            />
                        ))}
                    </ul>
                )}
                <Textarea
                    aria-describedby="chat-composer-keyboard-hint"
                    aria-label={messageLabel}
                    className="min-h-[62px] px-1 py-1 text-base sm:min-h-[72px]"
                    data-testid={dataTestId.messageComposer}
                    disabled={disabled}
                    onChange={(event) => onDraftChange(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    value={draft}
                />
                <div className="mt-1 flex min-h-10 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        <div className="relative">
                            <button
                                aria-label="Add"
                                aria-expanded={addMenuOpen}
                                className="flex size-10 items-center justify-center rounded-full text-copy-secondary outline-none hover:bg-black/[0.045] focus-visible:ring-2 focus-visible:ring-ring/60 aria-expanded:bg-black/[0.045]"
                                onClick={() => setAddMenuOpen((open) => !open)}
                                title="Add"
                                type="button"
                            >
                                {attachmentState.kind === "reading" ? (
                                    <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
                                ) : (
                                    <Plus className="size-5" />
                                )}
                            </button>
                            {addMenuOpen && (
                                <div
                                    className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-56 rounded-2xl border border-[#d5d9dc] bg-white p-1.5 shadow-[0_16px_42px_rgba(0,0,0,0.14)]"
                                    role="menu"
                                >
                                    <button
                                        className="flex min-h-10 w-full items-center gap-3 rounded-xl bg-black/[0.035] px-3 text-left text-sm hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-ring/60"
                                        disabled={
                                            disabled || attachmentState.kind === "reading" || attachments.length >= 8
                                        }
                                        onClick={() => {
                                            setAddMenuOpen(false);
                                            fileInput.current?.click();
                                        }}
                                        role="menuitem"
                                        type="button"
                                    >
                                        <Paperclip aria-hidden="true" className="size-4 text-copy-secondary" />
                                        Add attachment
                                    </button>
                                </div>
                            )}
                        </div>
                        <input
                            accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.xml"
                            className="sr-only"
                            disabled={disabled}
                            multiple
                            onChange={(event) => {
                                if (event.currentTarget.files !== null) {
                                    attachFiles(event.currentTarget.files);
                                }
                            }}
                            ref={fileInput}
                            type="file"
                        />
                        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">{children}</div>
                    </div>
                    <Button
                        aria-busy={outputState === "sending"}
                        aria-label={
                            outputState === "sending"
                                ? "Sending message"
                                : outputState === "running"
                                  ? "Stop agent output"
                                  : outputState === "stopping"
                                    ? "Stopping agent output"
                                    : submitLabel
                        }
                        className={`size-10 rounded-full text-white ${outputState === "idle" || outputState === "sending" ? "bg-[#2fbd7a] hover:bg-[#28aa6c]" : "bg-[#e65c5c] hover:bg-[#d94d4d]"}`}
                        data-testid={dataTestId.sendMessage}
                        disabled={
                            outputState === "sending" ||
                            outputState === "stopping" ||
                            (outputState === "idle" && submitDisabled)
                        }
                        onClick={outputState === "running" ? onStop : undefined}
                        size="icon"
                        type={outputState === "idle" ? "submit" : "button"}
                    >
                        {outputState === "idle" ? (
                            <Send aria-hidden="true" className="size-[18px]" />
                        ) : outputState === "running" ? (
                            <Square aria-hidden="true" className="size-3.5 fill-current" />
                        ) : outputState === "sending" ? (
                            <LoaderCircle
                                aria-label="Sending message"
                                className="size-[18px] animate-spin motion-reduce:animate-none"
                                role="status"
                            />
                        ) : (
                            <LoaderCircle
                                aria-hidden="true"
                                className="size-[18px] animate-spin motion-reduce:animate-none"
                            />
                        )}
                    </Button>
                </div>
            </div>
            <span className="sr-only" id="chat-composer-keyboard-hint">
                Enter to send. Shift or Control plus Enter inserts a new line.
            </span>
        </form>
    );
}
