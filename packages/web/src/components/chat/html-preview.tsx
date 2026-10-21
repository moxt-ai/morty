export function HtmlPreview({ onAttach }: { readonly onAttach: (frame: HTMLIFrameElement) => () => void }) {
    return (
        <iframe
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            className="h-full min-h-0 w-full flex-1 border-0 bg-white"
            ref={onAttach}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-forms"
            title="HTML preview"
        />
    );
}
