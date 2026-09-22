import { FileText } from "lucide-react";
import * as v from "valibot";
import { dataTestId } from "../../data-testid.ts";
import type { ToolCallState } from "../../services/chat/agent-reply.ts";
import { HighlightedCode, languageForPath } from "./highlighted-code.tsx";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";

const readResponseSchema = v.pipe(
    v.strictObject({
        exit_code: v.optional(v.number()),
        formatted_output: v.string(),
    }),
    v.readonly(),
);
const pathReadRequestSchema = v.pipe(
    v.strictObject({
        limit: v.optional(v.number()),
        offset: v.optional(v.number()),
        path: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);
const filePathReadRequestSchema = v.pipe(
    v.strictObject({
        file_path: v.pipe(v.string(), v.minLength(1)),
        limit: v.optional(v.number()),
        offset: v.optional(v.number()),
    }),
    v.readonly(),
);

type ReadRequest =
    | {
          readonly kind: "path";
          readonly limit?: number;
          readonly offset?: number;
          readonly path: string;
      }
    | {
          readonly filePath: string;
          readonly kind: "file-path";
          readonly limit?: number;
          readonly offset?: number;
      };

type NumberedCodeLine = {
    readonly code: string;
    readonly lineNumber: number;
};

type ReadOutput =
    | { readonly kind: "formatted"; readonly text: string }
    | { readonly kind: "numbered-lines"; readonly lines: readonly NumberedCodeLine[] };

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function readRequest(value: string): ReadRequest | null {
    const decoded = parseJson(value);
    const pathResult = v.safeParse(pathReadRequestSchema, decoded);
    if (pathResult.success) {
        return {
            kind: "path",
            path: pathResult.output.path,
            ...(pathResult.output.limit === undefined ? {} : { limit: pathResult.output.limit }),
            ...(pathResult.output.offset === undefined ? {} : { offset: pathResult.output.offset }),
        };
    }

    const filePathResult = v.safeParse(filePathReadRequestSchema, decoded);
    if (filePathResult.success) {
        return {
            filePath: filePathResult.output.file_path,
            kind: "file-path",
            ...(filePathResult.output.limit === undefined ? {} : { limit: filePathResult.output.limit }),
            ...(filePathResult.output.offset === undefined ? {} : { offset: filePathResult.output.offset }),
        };
    }

    return null;
}

function formattedReadOutput(value: string): ReadOutput | null {
    const result = v.safeParse(readResponseSchema, parseJson(value));
    return result.success ? { kind: "formatted", text: result.output.formatted_output.trimEnd() } : null;
}

function numberedReadOutput(value: string): ReadOutput | null {
    const normalized = value.replace(/\n+$/u, "");
    if (normalized.length === 0) {
        return null;
    }

    const lines: NumberedCodeLine[] = [];
    for (const line of normalized.split("\n")) {
        const match = /^(\d+)\t(.*)$/u.exec(line);
        const lineNumberText = match?.[1];
        const code = match?.[2];
        if (lineNumberText === undefined || code === undefined) {
            return null;
        }
        lines.push({ code, lineNumber: Number(lineNumberText) });
    }
    return { kind: "numbered-lines", lines };
}

function readOutputForRequest(request: ReadRequest, value: string): ReadOutput | null {
    switch (request.kind) {
        case "path":
            return formattedReadOutput(value);
        case "file-path":
            return numberedReadOutput(value);
    }
}

function readOutput(value: string): ReadOutput | null {
    return formattedReadOutput(value) ?? numberedReadOutput(value);
}

export function matchesReadTool(input: string, output: string): boolean {
    return readRequest(input) !== null || readOutput(output) !== null;
}

function NumberedCodeLines({ lines }: { readonly lines: readonly NumberedCodeLine[] }) {
    return (
        <div className="max-h-96 overflow-auto rounded-lg bg-black/[0.035] p-2 font-mono text-xs leading-5">
            {lines.map((line) => (
                <div className="grid min-w-max grid-cols-[max-content_minmax(0,1fr)] gap-3" key={line.lineNumber}>
                    <span className="select-none text-right text-copy-tertiary">{line.lineNumber}</span>
                    <code className="whitespace-pre">{line.code}</code>
                </div>
            ))}
        </div>
    );
}

export function ReadTool({
    autoOpen,
    input,
    output,
    state,
    title,
}: {
    readonly autoOpen: boolean;
    readonly input: string;
    readonly output: string;
    readonly state: ToolCallState;
    readonly title: string;
}) {
    const request = readRequest(input);
    const response = request === null ? readOutput(output) : readOutputForRequest(request, output);
    const path = request === null ? title : request.kind === "path" ? request.path : request.filePath;
    const disclosure = useToolCallDisclosure(autoOpen);
    return (
        <details
            aria-label={`Read: ${title}`}
            className="group/tool min-w-0"
            data-testid={dataTestId.recognizedReadToolCall}
            ref={disclosure}
        >
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
            >
                <FileText aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{title}</span>
                <ToolCallStatus state={state} />
            </summary>
            <div className="mt-1 ml-5 grid min-w-0 gap-2 text-xs">
                {input.length > 0 && (
                    <div className="grid gap-1">
                        <span className="font-medium text-copy-tertiary">Request</span>
                        <pre className="overflow-x-auto rounded-lg bg-black/[0.035] p-2 whitespace-pre-wrap">
                            {input}
                        </pre>
                    </div>
                )}
                {output.length > 0 &&
                    (response?.kind === "numbered-lines" ? (
                        <NumberedCodeLines lines={response.lines} />
                    ) : (
                        <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                            <HighlightedCode
                                code={response?.kind === "formatted" ? response.text : output}
                                language={languageForPath(path)}
                            />
                        </div>
                    ))}
            </div>
        </details>
    );
}
