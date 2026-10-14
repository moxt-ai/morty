import { FileText, LoaderCircle, Plus, Send, Square, X } from "lucide-react";
import { type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import {
    AttachmentReadError,
    ReadPromptImage,
    ReadPromptResource,
    readPromptAttachment,
} from "../../services/chat/attachment-reader.ts";
import type { ComposerAttachment } from "../../view-models/chat/composer-attachment.ts";
import { Button } from "../ui/cloud-button.tsx";
import { Textarea } from "../ui/textarea.tsx";

export type { ComposerAttachment } from "../../view-models/chat/composer-attachment.ts";

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
    const [attachmentState, setAttachmentState] = useState<
        { readonly kind: "idle" } | { readonly kind: "reading" } | { readonly kind: "failed"; readonly message: string }
    >({ kind: "idle" });

    const attachFiles = (files: readonly File[]): void => {
        setAttachmentState({ kind: "reading" });
        void Promise.all(files.slice(0, Math.max(0, 8 - attachments.length)).map(readPromptAttachment))
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
    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (images.length === 0 || disabled || attachmentState.kind === "reading" || attachments.length >= 8) {
            return;
        }
        event.preventDefault();
        attachFiles(images);
    };
    const submitAction = outputState === "idle" || (outputState === "running" && !submitDisabled);

    return (
        <form
            className="mx-auto mt-4 mb-4 w-full max-w-[920px] shrink-0 px-3 sm:mt-5 sm:mb-5 sm:px-5"
            onSubmit={submit}
        >
            {(error.length > 0 || attachmentState.kind === "failed") && (
                <p className="mb-2 px-1 text-sm text-destructive" role="alert">
                    {error.length > 0 ? error : attachmentState.kind === "failed" ? attachmentState.message : ""}
                </p>
            )}
            <div className="rounded-[22px] border border-border bg-surface-elevated px-3 pt-3 pb-2.5 shadow-[0_8px_28px_rgba(23,30,36,0.06)] transition-[border-color,box-shadow] focus-within:border-primary/35 focus-within:shadow-[0_10px_32px_rgba(23,30,36,0.08),0_0_0_3px_rgba(34,123,78,0.06)] sm:min-h-[128px] sm:px-4 sm:pt-3.5 sm:pb-3 motion-reduce:transition-none">
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
                    className="min-h-[56px] px-1 py-1 text-base sm:min-h-[64px]"
                    data-testid={dataTestId.messageComposer}
                    disabled={disabled}
                    onChange={(event) => onDraftChange(event.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder={placeholder}
                    value={draft}
                />
                <div className="mt-1 flex min-h-10 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        <button
                            aria-label="Add attachment"
                            className="flex size-11 items-center justify-center rounded-full text-copy-secondary outline-none transition-colors duration-150 hover:bg-black/[0.045] focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 sm:size-10 motion-reduce:transition-none"
                            disabled={disabled || attachmentState.kind === "reading" || attachments.length >= 8}
                            onClick={() => fileInput.current?.click()}
                            title="Add attachment"
                            type="button"
                        >
                            {attachmentState.kind === "reading" ? (
                                <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
                            ) : (
                                <Plus className="size-5" />
                            )}
                        </button>
                        <input
                            aria-label="Choose attachments"
                            accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.xml"
                            className="sr-only"
                            disabled={disabled}
                            multiple
                            onChange={(event) => {
                                if (event.currentTarget.files !== null) {
                                    attachFiles(Array.from(event.currentTarget.files));
                                }
                            }}
                            ref={fileInput}
                            type="file"
                        />
                        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">{children}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            aria-busy={outputState === "sending"}
                            aria-label={
                                outputState === "sending"
                                    ? "Sending message"
                                    : outputState === "stopping"
                                      ? "Stopping agent output"
                                      : submitAction
                                        ? submitLabel
                                        : "Stop agent output"
                            }
                            className={`size-11 rounded-full text-white shadow-sm sm:size-10 ${submitAction || outputState === "sending" ? "bg-primary hover:bg-primary/90" : "bg-destructive hover:bg-destructive/90"}`}
                            data-testid={dataTestId.sendMessage}
                            disabled={
                                outputState === "sending" ||
                                outputState === "stopping" ||
                                (outputState === "idle" && submitDisabled)
                            }
                            onClick={outputState === "running" && !submitAction ? onStop : undefined}
                            size="icon"
                            type={submitAction ? "submit" : "button"}
                        >
                            {submitAction || outputState === "sending" ? (
                                <Send aria-hidden="true" className="size-[18px]" />
                            ) : (
                                <Square aria-hidden="true" className="size-3.5 fill-current" />
                            )}
                        </Button>
                    </div>
                </div>
            </div>
            <span className="sr-only" id="chat-composer-keyboard-hint">
                Enter to send. Shift or Control plus Enter inserts a new line.
            </span>
        </form>
    );
}
