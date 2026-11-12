import * as v from "valibot";
import setupTemplate from "../../../../../../web/content/instructions/setup.txt?raw";

const instructionOriginSchema = v.pipe(
    v.string(),
    v.url(),
    v.regex(/^https?:\/\/[a-zA-Z0-9.:[\]-]+$/u),
    v.check((value) => URL.canParse(value) && new URL(value).origin === value),
);

export function instructionOrigin(value: unknown): string | null {
    const origin = v.safeParse(instructionOriginSchema, value);
    return origin.success ? origin.output : null;
}

export function renderSetupDocument(origin: string): string {
    return setupTemplate.replaceAll("{{BASE_URL}}", origin);
}
