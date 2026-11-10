import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { RELAY_APP_PROJECT_PERMISSIONS } from "../packages/client/src/protocol/index.ts";
import { serviceCredential } from "../packages/relay/src/schema/d1/index.ts";

/** Local development provisioning uses storage, without installing a privileged HTTP bootstrap route. */
export async function provisionLocalService(config: string, persistTo: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const appId = `app_${randomBytes(18).toString("base64url")}`;
    const credentialId = `credential_${randomBytes(18).toString("base64url")}`;
    const publicCredentialId = randomBytes(16).toString("base64url");
    const appSecret = `mapp_${publicCredentialId}_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    const db = drizzle(async () => {
        throw new Error("Provisioning only compiles statements");
    });
    const statements = [
        db
            .insert(serviceCredential)
            .values({
                credentialId,
                publicCredentialId,
                appId,
                secretDigest: createHash("sha256").update(appSecret).digest("hex"),
                permissionsJson: JSON.stringify(RELAY_APP_PROJECT_PERMISSIONS),
                allProjects: 1,
                issuedAt: now,
            })
            .toSQL(),
    ];
    const sql = statements
        .map((statement) => {
            let index = 0;
            return `${statement.sql.replaceAll("?", () => {
                const value: unknown = statement.params[index++];
                if (value === null) {
                    return "NULL";
                }
                if (typeof value === "number" && Number.isSafeInteger(value)) {
                    return String(value);
                }
                if (typeof value === "string") {
                    return `'${value.replaceAll("'", "''")}'`;
                }
                throw new Error("Unsupported provisioning parameter");
            })};`;
        })
        .join("\n");
    const directory = await mkdtemp(resolve(tmpdir(), "morty-local-provision-"));
    try {
        const file = resolve(directory, "service.sql");
        await writeFile(file, sql, { mode: 0o600 });
        await promisify(execFile)(
            process.execPath,
            [
                resolve(import.meta.dirname, "../node_modules/wrangler/bin/wrangler.js"),
                "d1",
                "execute",
                "RELAY_DIRECTORY_DATABASE",
                "--local",
                "--config",
                config,
                "--persist-to",
                persistTo,
                "--file",
                file,
            ],
            { signal, timeout: 60_000, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
        );
        return { appId, appSecret };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

if (process.argv[1] === import.meta.filename) {
    const [config, persistTo] = process.argv.slice(2);
    if (config === undefined || persistTo === undefined) {
        throw new Error("Local config and storage directory are required");
    }
    console.log(
        JSON.stringify(await provisionLocalService(resolve(config), resolve(persistTo), AbortSignal.timeout(60_000))),
    );
}
