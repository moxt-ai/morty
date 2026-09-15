import { PlatformProjectError } from "./platform-project.ts";

export function projectRegion(projectId: string): "apac" | "wnam" {
    const match = /^prj_(a01|a02|w01|w02)_[A-Za-z0-9_-]{24}$/.exec(projectId);
    if (match?.[0] !== projectId) {
        throw new PlatformProjectError("INVALID_PROJECT_ID", "The Project ID is invalid.", 400);
    }
    return match[1]?.startsWith("a") ? "apac" : "wnam";
}
