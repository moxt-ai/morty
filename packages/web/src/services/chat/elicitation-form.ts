import type { SessionElicitationField } from "@morty-build/client";

/** What a field holds while it is answered: its text as typed, yes or no, or the options chosen. */
export type ElicitationFieldValue = string | boolean | readonly string[];

/** What a field shows before the user changes it: the Agent's default, or nothing. */
function initialElicitationFieldValue(field: SessionElicitationField): ElicitationFieldValue {
    switch (field.type) {
        case "boolean":
            return field.hasDefaultValue && field.defaultBooleanValue;
        case "multiselect":
            return readMultiselectDefaults(field);
        case "integer":
        case "number":
            return field.hasDefaultValue ? String(field.defaultNumberValue) : "";
        default:
            return field.hasDefaultValue ? field.defaultStringValue : "";
    }
}

/** The value each field holds: the user's answer so far, or what it shows before any. */
export function elicitationFieldValue(
    field: SessionElicitationField,
    answers: Readonly<Record<string, ElicitationFieldValue>>,
): ElicitationFieldValue {
    return Object.hasOwn(answers, field.name) ? (answers[field.name] ?? "") : initialElicitationFieldValue(field);
}

/** The content an accepted request sends: each field's value as its type asks, leaving out empty optional ones. */
export function encodeElicitationAnswers(
    fields: readonly SessionElicitationField[],
    answers: Readonly<Record<string, ElicitationFieldValue>>,
): string {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
        const value = elicitationFieldValue(field, answers);
        if (field.type === "boolean") {
            values[field.name] = value === true;
            continue;
        }
        if (field.type === "multiselect") {
            const selections = Array.isArray(value) ? value : [];
            if (selections.length > 0 || field.required) {
                values[field.name] = selections;
            }
            continue;
        }
        if (typeof value !== "string" || (value.length === 0 && (field.type !== "string" || !field.required))) {
            continue;
        }
        values[field.name] = field.type === "integer" || field.type === "number" ? Number(value) : value;
    }
    return JSON.stringify(values);
}

function readMultiselectDefaults(field: SessionElicitationField): readonly string[] {
    if (!field.hasDefaultValue || field.defaultStringValue.length === 0) {
        return [];
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(field.defaultStringValue);
    } catch {
        return [];
    }
    if (!Array.isArray(decoded)) {
        return [];
    }
    const allowed = new Set(field.options.map((option) => option.value));
    return decoded.filter((value) => typeof value === "string" && allowed.has(value));
}
