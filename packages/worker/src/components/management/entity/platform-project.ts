import * as v from "valibot";

export const platformIdentifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
export const platformProjectSchema = v.pipe(
    v.object({ projectId: platformIdentifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(120)) }),
    v.readonly(),
);
export type PlatformProject = v.InferOutput<typeof platformProjectSchema>;

export class PlatformProjectError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number, options?: ErrorOptions) {
        super(message, options);
        this.name = "PlatformProjectError";
        this.code = code;
        this.status = status;
    }
}
