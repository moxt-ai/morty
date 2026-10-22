import { useState } from "react";
import { cn } from "@/lib/utils";

const MAX_FORMATTED_TOOL_TEXT_CHARACTERS = 32 * 1024;
const TOOL_TEXT_TAIL_CHARACTERS = MAX_FORMATTED_TOOL_TEXT_CHARACTERS / 2;

export function isOversizedToolText(text: string): boolean {
    return text.length > MAX_FORMATTED_TOOL_TEXT_CHARACTERS;
}

export function ToolTextPreview({ className, text }: { readonly className?: string; readonly text: string }) {
    const [visibleBeginningCharacters, setVisibleBeginningCharacters] = useState(TOOL_TEXT_TAIL_CHARACTERS);
    const beginningEnd = Math.min(visibleBeginningCharacters, text.length);
    const tailStart = Math.max(beginningEnd, text.length - TOOL_TEXT_TAIL_CHARACTERS);
    const omittedCharacters = tailStart - beginningEnd;

    return (
        <div className="min-w-0">
            <pre
                className={cn(
                    "m-0 max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap",
                    className,
                )}
            >
                {text.slice(0, beginningEnd)}
                {omittedCharacters > 0 && (
                    <span className="block py-2 text-copy-tertiary">
                        {omittedCharacters.toLocaleString()} characters omitted
                    </span>
                )}
                {text.slice(tailStart)}
            </pre>
            {omittedCharacters > 0 && (
                <button
                    className="mt-1 text-xs text-copy-secondary underline"
                    onClick={() =>
                        setVisibleBeginningCharacters((current) =>
                            Math.min(
                                current + MAX_FORMATTED_TOOL_TEXT_CHARACTERS,
                                text.length - TOOL_TEXT_TAIL_CHARACTERS,
                            ),
                        )
                    }
                    type="button"
                >
                    Load more output
                </button>
            )}
        </div>
    );
}
