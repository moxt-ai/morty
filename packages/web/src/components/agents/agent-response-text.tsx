import { memo, useState } from "react";
import { AgentMarkdown, type MarkdownImageReader } from "./agent-markdown.tsx";

const TEXT_PAGE_CHARACTERS = 32_000;

function pageBoundary(text: string, offset: number): number {
    if (offset === 0) {
        return 0;
    }
    if (offset >= text.length) {
        return text.length;
    }
    // Prefer a complete line so links, images and fence markers are not cut.
    const line = text.lastIndexOf("\n", offset - 1);
    if (line >= 0 && offset - line <= 4_000) {
        return line + 1;
    }
    const character = text.charCodeAt(offset);
    return character >= 0xdc00 && character <= 0xdfff ? offset - 1 : offset;
}

function markdownPage(text: string, page: number): string {
    const start = pageBoundary(text, page * TEXT_PAGE_CHARACTERS);
    const end = pageBoundary(text, (page + 1) * TEXT_PAGE_CHARACTERS);
    let fence: { readonly marker: string; readonly info: string } | null = null;
    // Carry a fenced code block into the next page without parsing the full answer.
    const markers = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gmu;
    for (let match = markers.exec(text); match !== null && match.index < start; match = markers.exec(text)) {
        const marker = match[1];
        const info = match[2];
        if (marker === undefined || info === undefined) {
            continue;
        }
        if (fence === null) {
            fence = { marker, info };
        } else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && info.trim() === "") {
            fence = null;
        }
    }
    const content = text.slice(start, end);
    return fence === null ? content : `${fence.marker}${fence.info}\n${content}`;
}

type MarkdownPageProps = {
    readonly markdown: string;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
};

const MarkdownPage = memo(function MarkdownPage({ markdown, openLocalFile, readImage }: MarkdownPageProps) {
    return (
        <AgentMarkdown
            className="[&_p]:my-0"
            markdown={markdown}
            openLocalFile={openLocalFile}
            readImage={readImage}
            streaming={false}
        />
    );
});

export function AgentResponseText({
    text,
    openLocalFile,
    readImage,
}: Omit<MarkdownPageProps, "markdown"> & { readonly text: string }) {
    const [loadedPages, setLoadedPages] = useState(1);
    if (text.length <= TEXT_PAGE_CHARACTERS) {
        return <MarkdownPage markdown={text} openLocalFile={openLocalFile} readImage={readImage} />;
    }
    const lastPage = Math.floor((text.length - 1) / TEXT_PAGE_CHARACTERS);
    const pages = [];
    for (let page = 0; page < Math.min(loadedPages, lastPage + 1); page++) {
        pages.push(
            <MarkdownPage
                key={page}
                markdown={markdownPage(text, page)}
                openLocalFile={openLocalFile}
                readImage={readImage}
            />,
        );
    }
    const hasGap = loadedPages < lastPage;
    return (
        <div>
            {pages}
            {hasGap && (
                <div className="my-3 space-y-2 text-sm text-muted-foreground">
                    <p>Some text between the beginning and latest output is not shown.</p>
                    <button className="underline" onClick={() => setLoadedPages(loadedPages + 1)} type="button">
                        Load more text
                    </button>
                    <p>Latest output</p>
                </div>
            )}
            {loadedPages <= lastPage && (
                <MarkdownPage
                    key={lastPage}
                    markdown={markdownPage(text, lastPage)}
                    openLocalFile={openLocalFile}
                    readImage={readImage}
                />
            )}
        </div>
    );
}
