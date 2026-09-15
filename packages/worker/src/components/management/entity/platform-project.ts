import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";

export const platformIdentifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
export const platformProjectSchema = v.pipe(
    v.object({ projectId: platformIdentifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(120)) }),
    v.readonly(),
);
export type PlatformProject = v.InferOutput<typeof platformProjectSchema>;

export class PlatformProjectError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number, options?: ErrorOptions) {
        super(message, options);
        this.name = "PlatformProjectError";
        this.code = code;
        this.status = status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
    });
}
