import { CircleHelp } from "lucide-react";
import * as v from "valibot";
import { ToolCallStatus, useToolCallDisclosure } from "./tool-call-status.tsx";
import type { ToolRendererProps } from "./tool-renderer.ts";

const textSchema = v.pipe(v.string(), v.maxLength(16_384));
const optionSchema = v.pipe(
    v.strictObject({
        description: textSchema,
        label: textSchema,
    }),
    v.readonly(),
);
const questionSchema = v.pipe(
    v.strictObject({
        header: textSchema,
        multiSelect: v.boolean(),
        options: v.pipe(v.array(optionSchema), v.maxLength(200), v.readonly()),
        question: textSchema,
    }),
    v.readonly(),
);
const requestSchema = v.pipe(
    v.strictObject({
        questions: v.pipe(v.array(questionSchema), v.minLength(1), v.maxLength(100), v.readonly()),
    }),
    v.readonly(),
);

function parseRequest(value: string): v.InferOutput<typeof requestSchema> | null {
    try {
        const decoded: unknown = JSON.parse(value);
        const request = v.safeParse(requestSchema, decoded);
        return request.success ? request.output : null;
    } catch {
        return null;
    }
}

export function matchesQuestionToolCall({ input, name }: ToolRendererProps["entry"]): boolean {
    return name === "question" && parseRequest(input) !== null;
}

export function QuestionToolCall({ autoOpen, entry }: ToolRendererProps) {
    const request = parseRequest(entry.input);
    const disclosure = useToolCallDisclosure(autoOpen);
    if (request === null) {
        return null;
    }
    return (
        <details aria-label={`Questions: ${entry.title}`} className="group/tool min-w-0" ref={disclosure}>
            <summary
                className="flex min-h-8 w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-sm text-copy-secondary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title={entry.title}
            >
                <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{entry.title}</span>
                <ToolCallStatus state={entry.state} />
            </summary>
            <div className="mt-2 ml-5 grid min-w-0 gap-4 text-sm">
                {request.questions.map((question, questionIndex) => (
                    <section
                        className="grid gap-2 rounded-lg border border-black/7 bg-black/[0.025] p-3"
                        key={`${question.header}:${questionIndex.toString()}`}
                    >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <h4 className="font-semibold text-foreground">{question.header}</h4>
                            <span className="text-[11px] text-copy-tertiary">
                                {question.multiSelect ? "Multiple choices" : "Single choice"}
                            </span>
                        </div>
                        <p className="leading-5 text-copy-secondary">{question.question}</p>
                        <ul className="grid gap-2">
                            {question.options.map((option, optionIndex) => (
                                <li
                                    className="rounded-md border border-black/7 bg-white/70 px-3 py-2"
                                    key={`${option.label}:${optionIndex.toString()}`}
                                >
                                    <p className="font-medium text-foreground">{option.label}</p>
                                    {option.description.length > 0 && (
                                        <p className="mt-1 text-xs leading-5 text-copy-secondary">
                                            {option.description}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </details>
    );
}
