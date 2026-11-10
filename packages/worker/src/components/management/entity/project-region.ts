import { ComputerManagementError } from "./computer-management.ts";

export function projectRegion(computerId: string): "apac" | "apac-ne" | "apac-se" | "wnam" {
    const match = /^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/.exec(computerId);
    if (match?.[0] !== computerId) {
        throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Project ID is invalid.", 400);
    }
    if (match[1] === "an") {
        return "apac-ne";
    }
    if (match[1] === "as") {
        return "apac-se";
    }
    return match[1] === "ap" || match[1] === "oc" ? "apac" : "wnam";
}
