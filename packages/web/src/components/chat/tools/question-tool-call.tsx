import { CircleHelp } from "lucide-react";
import * as v from "valibot";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
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

export function matchesQuestionToolCall({ input }: ToolRendererProps["entry"]): boolean {
    return parseRequest(input) !== null;
}

export function QuestionToolCall({ autoOpen, entry }: ToolRendererProps) {
    const request = parseRequest(entry.input);
    if (request === null) {
        return null;
    }
    return (
        <ToolCallDisclosure
            ariaLabel={`Questions: ${entry.title}`}
            autoOpen={autoOpen}
            icon={<CircleHelp aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={entry.title}
        >
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
        </ToolCallDisclosure>
    );
}
