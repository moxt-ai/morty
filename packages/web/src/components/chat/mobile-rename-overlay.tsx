import { Check, X } from "lucide-react";
import { createPortal } from "react-dom";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/cloud-button.tsx";
import { inputClassName } from "../ui/input.tsx";
import { useSoftwareKeyboardMarker } from "../utils/use-software-keyboard-marker.ts";
import { AutoFocusInput } from "./auto-focus-input.tsx";
import { useConfigurationViewport } from "./chat-configuration-viewport.ts";

/**
 * Phone rename editor: a mask over the whole chat with the input bar pinned above
 * the software keyboard, so typing and confirming happen at the thumb's bottom edge.
 */
export function MobileRenameOverlay({
    draft,
    saving,
    onSetTitleDraft,
    onCancelTitleEdit,
    onConfirmTitleEdit,
}: {
    readonly draft: string;
    readonly saving: boolean;
    readonly onSetTitleDraft: (draft: string) => void;
    readonly onCancelTitleEdit: () => void;
    readonly onConfirmTitleEdit: () => void;
}) {
    const viewport = useConfigurationViewport();
    const attachKeyboardMarker = useSoftwareKeyboardMarker();
    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Rename conversation"
            className="fixed inset-0 z-[132] sm:hidden"
        >
            <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                data-testid={dataTestId.mobileRenameMask}
                className="absolute inset-0 bg-black/30"
                onClick={onCancelTitleEdit}
            />
            <div
                className="absolute inset-x-0 flex items-center gap-2 border-t border-border/60 bg-card px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] data-[software-keyboard=open]:pb-2"
                ref={attachKeyboardMarker}
                style={{ bottom: viewport.bottom }}
            >
                <AutoFocusInput
                    aria-label="Conversation title"
                    className={cn(inputClassName, "h-10 rounded-full! px-4 text-[16px]")}
                    disabled={saving}
                    enterKeyHint="done"
                    maxLength={500}
                    value={draft}
                    onChange={(event) => onSetTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            onConfirmTitleEdit();
                        }
                        if (event.key === "Escape") {
                            onCancelTitleEdit();
                        }
                    }}
                />
                <Button
                    aria-label="Cancel rename"
                    className="size-10 rounded-full px-0 text-copy-secondary"
                    disabled={saving}
                    variant="ghost"
                    onClick={onCancelTitleEdit}
                >
                    <X className="size-5" />
                </Button>
                <Button
                    aria-label="Save title"
                    className="size-10 rounded-full px-0"
                    disabled={saving}
                    onClick={onConfirmTitleEdit}
                >
                    <Check className="size-5" />
                </Button>
            </div>
        </div>,
        document.body,
    );
}
