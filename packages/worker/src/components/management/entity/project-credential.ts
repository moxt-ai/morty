import * as v from "valibot";

const projectId = v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u));
const secret = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
const credential = v.tuple([v.picklist(["mobius_pair_v2", "mobius_transfer_v2"]), projectId, secret]);

export function readProjectCredential(value: unknown) {
    if (typeof value !== "string") {
        return null;
    }
    const parsed = v.safeParse(credential, value.split("."));
    if (!parsed.success) {
        return null;
    }
    const [kind, projectId] = parsed.output;
    return { kind, projectId };
}

export function createProjectCredential(kind: "mobius_pair_v2" | "mobius_transfer_v2", requestedProjectId: string) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const value = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
    return `${kind}.${v.parse(projectId, requestedProjectId)}.${value}`;
}
