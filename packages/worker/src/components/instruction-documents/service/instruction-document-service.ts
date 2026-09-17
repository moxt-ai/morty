import * as v from "valibot";
import pairTemplate from "../../../../../../templates/pair.md?raw";
import setupTemplate from "../../../../../../templates/setup.md?raw";

const instructionOriginSchema = v.pipe(
    v.string(),
    v.url(),
    v.regex(/^https?:\/\/[a-zA-Z0-9.:[\]-]+$/u),
    v.check((value) => URL.canParse(value) && new URL(value).origin === value),
);

export type InstructionDocument = "pair" | "setup";

export function instructionOrigin(value: unknown): string | null {
    const origin = v.safeParse(instructionOriginSchema, value);
    return origin.success ? origin.output : null;
}

export function renderInstructionDocument(document: InstructionDocument, origin: string): string {
    const template = document === "setup" ? setupTemplate : pairTemplate;
    return template.replaceAll("{{BASE_URL}}", origin);
}
