// One resource policy for every HTML result. The frame receives only file content,
// never session credentials or a bridge to Morty's APIs.
const STATIC_ORIGINS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh";
const CONTENT_POLICY = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${STATIC_ORIGINS}`,
    `style-src 'unsafe-inline' ${STATIC_ORIGINS} https://fonts.googleapis.com`,
    `img-src data: blob: ${STATIC_ORIGINS}`,
    `font-src data: ${STATIC_ORIGINS} https://fonts.gstatic.com`,
    `media-src data: blob: ${STATIC_ORIGINS}`,
    `connect-src ${STATIC_ORIGINS}`,
    "base-uri https://preview.invalid",
    // The sandbox permits form events for local tools; submissions cannot leave
    // the document, even when a page does not prevent its form's default action.
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
].join("; ");

export type HtmlPreviewFailure = "resource" | "script" | "policy";

export interface HtmlPreviewDocument {
    readonly id: string;
    readonly source: string;
}

export function createHtmlPreviewDocument(html: string): HtmlPreviewDocument {
    const id = crypto.randomUUID();
    // Install diagnostics and the restrictive policy before any untrusted markup.
    // A second CSP in the supplied document can only restrict this policy further.
    // No source rewriting or library-specific compatibility patches are performed.
    const source = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="${CONTENT_POLICY}">
<meta name="referrer" content="no-referrer">
<base href="https://preview.invalid/">
<script>
(() => {
    let reported = false;
    const report = (code) => {
        if (reported) return;
        reported = true;
        parent.postMessage({ type: "morty-html-preview", id: ${JSON.stringify(id)}, code }, "*");
    };
    addEventListener("error", (event) => report(event.target === window ? "script" : "resource"), true);
    addEventListener("unhandledrejection", () => report("script"));
    addEventListener("securitypolicyviolation", () => report("policy"));
})();
</script>
${html}`;
    return { id, source };
}

export function observeHtmlPreview(
    frame: Window,
    id: string,
    report: (id: string, code: HtmlPreviewFailure) => void,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        // Opaque frames all report origin "null"; source and document identity are
        // required. Diagnostics are untrusted hints and grant no capabilities.
        if (event.source !== frame || event.origin !== "null") {
            return;
        }
        const data = event.data;
        if (
            typeof data !== "object" ||
            data === null ||
            !("type" in data) ||
            data.type !== "morty-html-preview" ||
            !("id" in data) ||
            data.id !== id ||
            !("code" in data)
        ) {
            return;
        }
        if (data.code === "resource" || data.code === "script" || data.code === "policy") {
            report(id, data.code);
        }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
}
