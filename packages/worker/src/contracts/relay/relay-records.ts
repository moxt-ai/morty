import * as v from "valibot";

const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const RelayComputerScopeRowSchema = v.object({ computer_id: v.string() });
export type RelayComputerScopeRow = Readonly<v.InferOutput<typeof RelayComputerScopeRowSchema>>;

/** A computer's account: which computer it is, and when it was created. */
export const ProjectRowSchema = v.object({
    created_at: nonNegativeInteger,
    computer_id: v.string(),
});
export type ProjectRow = Readonly<v.InferOutput<typeof ProjectRowSchema>>;
