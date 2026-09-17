import { PlatformProjectError } from "./platform-project.ts";

export function projectRegion(projectId: string): "apac" | "apac-ne" | "apac-se" | "wnam" {
    const match = /^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/.exec(projectId);
    if (match?.[0] !== projectId) {
        throw new PlatformProjectError("INVALID_PROJECT_ID", "The Project ID is invalid.", 400);
    }
    if (match[1] === "an") {
        return "apac-ne";
    }
    if (match[1] === "as") {
        return "apac-se";
    }
    return match[1] === "ap" || match[1] === "oc" ? "apac" : "wnam";
}
