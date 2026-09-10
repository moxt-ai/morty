import * as v from "valibot";

// Preserve URL-constructor validation and the existing whitespace normalization.
export const urlSchema = v.pipe(
    v.string(),
    v.trim(),
    v.check((value) => URL.canParse(value)),
    v.transform((value) => value.replace(/[\t\n\r]/g, "")),
);
