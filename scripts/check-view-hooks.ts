import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Forbids React hooks in packages/web/src/views.
 *
 * Views render view-model state and wire DOM callbacks. They read stores through `useStore` or `useExternalStore`,
 * routing through the router's hooks, and the application through `useMortyApplication`. Every other hook, including
 * a component's own hook such as a media query or a motion state, belongs to a component in
 * packages/web/src/components, which a view renders instead of calling the hook. Namespace calls such as
 * `React.useState` count as hook calls too.
 */

const SCANNED = "packages/web/src/views";
const ALLOWED_HOOKS = new Set(["useStore", "useExternalStore", "useParams", "useRouter", "useMortyApplication"]);
const HOOK_CALL = /(?<![\w.$])(?:\w+\.)?(use[A-Z]\w*)\s*(?:<[^()]*>)?\s*\(/gu;
// The application context is the one place a view reads React context, for `useMortyApplication`.
const CONTEXT_OWNER = "packages/web/src/views/application/application-context.tsx";

const git = spawnSync("git", ["ls-files", SCANNED], { encoding: "utf8" });
if (git.status !== 0) {
    process.stderr.write(git.stderr);
    process.exit(1);
}

const violations: string[] = [];
for (const path of git.stdout.split("\n").filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"))) {
    if (!existsSync(path)) {
        continue;
    }
    readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
            if (/^\s*(?:\/\/|\*|\/\*)/u.test(line) || /^\s*(?:export\s+)?function\s+use[A-Z]/u.test(line)) {
                return;
            }
            for (const match of line.matchAll(HOOK_CALL)) {
                const hook = match[1] ?? "";
                if (ALLOWED_HOOKS.has(hook) || (path === CONTEXT_OWNER && hook === "useContext")) {
                    continue;
                }
                violations.push(
                    `${path}:${index + 1}:${(match.index ?? 0) + 1} ${hook} is a hook; views render a component that owns it`,
                );
            }
        });
}

if (violations.length > 0) {
    for (const violation of violations) {
        process.stderr.write(`${violation}\n`);
    }
    process.exit(1);
}
