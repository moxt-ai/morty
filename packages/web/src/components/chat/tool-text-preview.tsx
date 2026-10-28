import { useState } from "react";
import { MAX_FORMATTED_TOOL_TEXT_CHARACTERS, TOOL_TEXT_TAIL_CHARACTERS } from "@/lib/tool-text";
import { cn } from "@/lib/utils";
import { textLinkClassName } from "../ui/text-link.ts";

export { isOversizedToolText } from "@/lib/tool-text";

export function ToolTextPreview({ className, text }: { readonly className?: string; readonly text: string }) {
    const [visibleBeginningCharacters, setVisibleBeginningCharacters] = useState(TOOL_TEXT_TAIL_CHARACTERS);
    const beginningEnd = Math.min(visibleBeginningCharacters, text.length);
    const tailStart = Math.max(beginningEnd, text.length - TOOL_TEXT_TAIL_CHARACTERS);
    const omittedCharacters = tailStart - beginningEnd;

    return (
        <div className="min-w-0">
            <pre className={cn("m-0 rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap", className)}>
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
                    className={`mt-1 text-xs text-copy-secondary ${textLinkClassName}`}
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
