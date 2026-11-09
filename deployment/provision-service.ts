import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as v from "valibot";
import { PLATFORM_APP_PROJECT_PERMISSIONS } from "../packages/client/src/protocol/index.ts";
import { serviceCredential } from "../packages/relay/src/schema/d1/index.ts";

const account = "b903018a1c3d9d9a4bd68a11eb03e764";
const targetSchema = v.object({ d1_id: v.string(), app_id: v.string() });
const targetsSchema = v.object({
    account_id: v.literal(account),
    environments: v.object({ production: targetSchema }),
});
const targets = v.parse(targetsSchema, JSON.parse(await readFile(new URL("targets.json", import.meta.url), "utf8")));
const environment = v.parse(v.literal("production"), process.argv[2]);
const operation = v.parse(v.picklist(["prepare", "retire"]), process.argv[3]);
const target = targets.environments[environment];
const secret = v.parse(
    v.pipe(v.string(), v.regex(/^mapp_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u)),
    process.env["MORTY_SERVICE_SECRET"],
);
const apiToken = v.parse(v.pipe(v.string(), v.minLength(1)), process.env["CLOUDFLARE_API_TOKEN"]);
const publicCredentialId = secret.slice(5, 27);
const credentialId = `credential_${publicCredentialId}`;
const secretDigest = createHash("sha256").update(secret).digest("hex");
const database = drizzle(async () => {
    throw new Error("Provisioning compiles ORM statements only");
});
const envelope = v.object({
    success: v.literal(true),
    result: v.array(
        v.object({
            success: v.literal(true),
            results: v.array(v.record(v.string(), v.unknown())),
        }),
    ),
});
async function query(statement: { readonly sql: string; readonly params: readonly unknown[] }) {
    const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${target.d1_id}/query`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
            body: JSON.stringify(statement),
            signal: AbortSignal.timeout(30_000),
        },
    );
    if (!response.ok) {
        throw new Error(`Morty credential provisioning failed (${response.status})`);
    }
    const value = v.parse(envelope, await response.json());
    return value.result.flatMap((result) => result.results);
}
const credentials = await query(
    database
        .select()
        .from(serviceCredential)
        .where(eq(serviceCredential.publicCredentialId, publicCredentialId))
        .toSQL(),
);
const existing = credentials[0];
if (
    existing !== undefined &&
    (existing["service_id"] !== target.app_id ||
        existing["secret_digest"] !== secretDigest ||
        existing["revoked_at"] !== null)
) {
    throw new Error("The selected service credential conflicts with an existing or retired identity");
}
if (operation === "prepare") {
    if (existing === undefined) {
        await query(
            database
                .insert(serviceCredential)
                .values({
                    credentialId,
                    publicCredentialId,
                    appId: target.app_id,
                    secretDigest,
                    permissionsJson: JSON.stringify(PLATFORM_APP_PROJECT_PERMISSIONS),
                    allProjects: 1,
                    issuedAt: Date.now(),
                })
                .toSQL(),
        );
    }
} else {
    if (existing === undefined) {
        throw new Error("Prepare and deploy the new Morty service credential before retiring old credentials");
    }
    // Called only after the compiled deployment and its real HTTP/asset health checks pass.
    await query(
        database
            .update(serviceCredential)
            .set({ revokedAt: Date.now() })
            .where(
                and(
                    eq(serviceCredential.appId, target.app_id),
                    ne(serviceCredential.publicCredentialId, publicCredentialId),
                    isNull(serviceCredential.revokedAt),
                ),
            )
            .toSQL(),
    );
}
console.log(JSON.stringify({ environment, operation, appId: target.app_id, credentialId, secretDisclosed: false }));
