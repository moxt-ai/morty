import { useEffect, useRef } from "react";
import {
    type HtmlPreviewDocument,
    type HtmlPreviewFailure,
    observeHtmlPreview,
} from "../../services/chat/html-preview-document.ts";

export function HtmlPreview({
    document,
    onFailure,
}: {
    readonly document: HtmlPreviewDocument;
    readonly onFailure: (id: string, code: HtmlPreviewFailure) => void;
}) {
    const ref = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
        const frame = ref.current;
        if (frame === null || frame.contentWindow === null) {
            return;
        }
        const stop = observeHtmlPreview(frame.contentWindow, document.id, onFailure);
        // Attach diagnostics before the document can execute.
        frame.srcdoc = document.source;
        return () => {
            stop();
            frame.removeAttribute("srcdoc");
        };
    }, [document, onFailure]);
    return (
        <iframe
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            className="h-full min-h-0 w-full flex-1 border-0 bg-white"
            ref={ref}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-forms"
            title="HTML preview"
        />
    );
}
