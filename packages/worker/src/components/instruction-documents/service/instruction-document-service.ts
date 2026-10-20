import * as v from "valibot";
import connectTemplate from "../../../../../web/content/instructions/connect.txt?raw";
import setupTemplate from "../../../../../web/content/instructions/setup.txt?raw";

const instructionOriginSchema = v.pipe(
    v.string(),
    v.url(),
    v.regex(/^https?:\/\/[a-zA-Z0-9.:[\]-]+$/u),
    v.check((value) => URL.canParse(value) && new URL(value).origin === value),
);

const templates = { setup: setupTemplate, connect: connectTemplate };

export type InstructionDocument = keyof typeof templates;

export function instructionOrigin(value: unknown): string | null {
    const origin = v.safeParse(instructionOriginSchema, value);
    return origin.success ? origin.output : null;
}

export function renderInstructionDocument(document: InstructionDocument, origin: string): string {
    const template = templates[document];
    return template.replaceAll("{{BASE_URL}}", origin);
}
