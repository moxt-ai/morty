import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const source = `${root}/third-party/platform/packages/platform-app`;
const require = createRequire(`${source}/package.json`);
const { build } = await import(require.resolve("vite"));
const environment = process.argv[2];
const targets = JSON.parse(fs.readFileSync(`${root}/deployment/targets.json`));
const auth = targets.auth[environment];
if (!auth) {
    throw new Error("Unsupported deployment environment");
}
process.env.VITE_CLERK_PUBLISHABLE_KEY = auth.publishableKey;
process.env.VITE_MOBIUS_PLATFORM_ENDPOINT = auth.origin;
let transformed = 0;
await build({
    root: source,
    configFile: `${source}/vite.config.ts`,
    mode: "production",
    build: { outDir: `${root}/.deployment-output/${environment}/platform-assets`, emptyOutDir: true },
    plugins: auth.proxyUrl
        ? [
              {
                  name: "independent-clerk-proxy",
                  enforce: "pre",
                  transform(code, id) {
                      if (id !== `${source}/src/main.tsx`) {
                          return;
                      }
                      const before = "<ClerkProvider publishableKey={publishableKey}>";
                      if (code.split(before).length !== 2) {
                          throw new Error("Clerk provider source changed; review the proxy integration");
                      }
                      transformed++;
                      return code.replace(
                          before,
                          "<ClerkProvider publishableKey={publishableKey} proxyUrl=" +
                              JSON.stringify(auth.proxyUrl) +
                              ">",
                      );
                  },
              },
          ]
        : [],
});
if (auth.proxyUrl && transformed !== 1) {
    throw new Error("Clerk proxy integration was not applied");
}
