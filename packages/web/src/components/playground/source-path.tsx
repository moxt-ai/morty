import { useState } from "react";
import { Button } from "../ui/cloud-button.tsx";

export function SourcePath({ source }: { readonly source: string }) {
    const path = `packages/web/src/${source}`;
    const [copied, setCopied] = useState(false);
    return (
        <p className="mt-4 flex flex-wrap items-center gap-2">
            <code className="font-mono text-12 text-morty-text-3">{path}</code>
            <Button
                onClick={() => {
                    if (navigator.clipboard === undefined) {
                        return;
                    }
                    void navigator.clipboard.writeText(path).then(() => {
                        setCopied(true);
                    });
                }}
                size="sm"
                variant="ghost"
            >
                {copied ? "Copied" : "Copy path"}
            </Button>
        </p>
    );
}
