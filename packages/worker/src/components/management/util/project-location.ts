import * as v from "valibot";

// Use Cloudflare's request metadata, not client-supplied headers or JSON.
export function projectLocationHint(request: Request): "apac" | "wnam" | undefined {
    const metadata = v.safeParse(
        v.object({ continent: v.picklist(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]) }),
        "cf" in request ? request.cf : undefined,
    );
    if (!metadata.success) {
        return undefined;
    }
    return metadata.output.continent === "AS" || metadata.output.continent === "OC" ? "apac" : "wnam";
}
