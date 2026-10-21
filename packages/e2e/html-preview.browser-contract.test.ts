import { createServer } from "node:http";
import { expect, test } from "./infra/test.ts";

// These scenarios exercise the browser's untrusted-document boundary. happy-dom
// cannot establish origin, sandbox, CSP, or executable-document guarantees.
test("Given untrusted HTML executes, When it attempts privileged browser access, Then the host and its credentials remain isolated", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await runtime.writeFiles(
        new Map([
            [
                "/workspace/delivery-review.html",
                {
                    mediaType: "text/html",
                    content: `<!doctype html><h1>Boundary probe</h1>
<button id="check">Check boundary</button><ul id="results"></ul>
<script>
document.getElementById("check").onclick = () => {
    const check = (label, operation) => {
        let blocked = false;
        try { operation(); } catch { blocked = true; }
        const row = document.createElement("li");
        row.textContent = label + (blocked ? " blocked" : " accessible");
        document.getElementById("results").append(row);
    };
    check("Parent document", () => parent.document.body);
    check("Top document", () => top.document.body);
    check("Parent storage", () => parent.localStorage.length);
    check("Frame storage", () => localStorage.length);
    check("Parent API", () => parent.fetch);
    check("Parent navigation", () => { parent.location.href = "https://preview.invalid/escaped"; });
    check("Top navigation", () => { top.location.href = "https://preview.invalid/escaped"; });
    parent.postMessage({type: "morty-html-preview", id: "another-document", code: "script"}, "*");
};
</script>`,
                },
            ],
        ]),
    );
    await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open delivery review" }).click();
    const hostUrl = page.url();
    const preview = page.getByRole("dialog", { name: "Local file preview" });
    const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
    await result.getByRole("button", { name: "Check boundary" }).click();
    await expect(result.getByRole("listitem")).toHaveText([
        "Parent document blocked",
        "Top document blocked",
        "Parent storage blocked",
        "Frame storage blocked",
        "Parent API blocked",
        "Parent navigation blocked",
        "Top navigation blocked",
    ]);
    await expect(page).toHaveURL(hostUrl);
    await expect(preview.getByRole("alert")).toHaveCount(0);
    await preview.getByRole("button", { name: "Close file preview" }).click();
    await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message" }).fill("The host remains usable");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

// A real HTTP receiver observes whether preview data leaves the browser. No
// request interception can stand in for enforcing the navigation boundary.
async function createNavigationDestination() {
    const requests: string[] = [];
    const received = Promise.withResolvers<string>();
    const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        received.resolve(request.url ?? "");
        response.writeHead(200, { "content-type": "text/html" }).end("<h1>Navigation escaped</h1>");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        server.close();
        throw new Error("The navigation destination did not listen");
    }
    return {
        url: `http://127.0.0.1:${address.port}/capture?data=preview-navigation-canary`,
        requests,
        received: received.promise,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve())));
        },
    };
}

const navigationProbes: Readonly<Record<string, (url: string) => string>> = {
    script: (url) => `<button onclick='location.replace(${JSON.stringify(url)})'>Leave preview</button>`,
    link: (url) => `<a href="${url}">Leave preview</a>`,
    form: (url) => `<form action="${url}" method="post"><button type="submit">Leave preview</button></form>`,
    "meta refresh": (url) => `<meta http-equiv="refresh" content="0;url=${url}">`,
    "attribute breakout": (url) => `"></iframe><script>location.replace(${JSON.stringify(url)})</script>`,
};

for (const [method, markup] of Object.entries(navigationProbes)) {
    test(`Given untrusted HTML attempts ${method} navigation, When it tries to leave its document, Then no preview data reaches the destination and recovery remains available`, async ({
        runtime,
    }, testInfo) => {
        const destination = await createNavigationDestination();
        try {
            const { page } = runtime;
            await runtime.openPairedChat();
            await runtime.writeFiles(
                new Map([
                    [
                        "/workspace/delivery-review.html",
                        {
                            mediaType: "text/html",
                            content: `<!doctype html><h1>Private preview</h1>${markup(destination.url)}`,
                        },
                    ],
                ]),
            );
            await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
            await page.getByRole("button", { name: "Send message" }).click();
            await page.getByRole("button", { name: "Open delivery review" }).click();
            const preview = page.getByRole("dialog", { name: "Local file preview" });
            const result = page
                .frameLocator('iframe[title="HTML preview"]')
                .frameLocator('iframe[title="HTML content"]');
            if (method === "script" || method === "link" || method === "form") {
                await expect(result.getByText("Leave preview", { exact: true })).toBeVisible();
                await result.getByText("Leave preview", { exact: true }).click();
            }
            // The browser's policy violation is the completion signal; this
            // assertion does not depend on a sleep or a request polling window.
            await Promise.race([
                expect(preview.getByRole("alert")).toContainText("resource or capability"),
                destination.received.then((url) => {
                    throw new Error(`Preview navigation reached the destination: ${url}`);
                }),
            ]);
            expect(destination.requests).toEqual([]);
            await preview.screenshot({ path: testInfo.outputPath("html-navigation-blocked.png") });
            await preview.getByRole("button", { name: "View source" }).click();
            await expect(preview.getByRole("region", { name: "File contents" })).toContainText("Private preview");
            await expect(preview.getByRole("button", { name: "Reload file" })).toBeEnabled();
            await preview.getByRole("button", { name: "Close file preview" }).click();
            await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
        } finally {
            await destination.close();
            await testInfo.attach("navigation-requests", {
                body: JSON.stringify(destination.requests),
                contentType: "application/json",
            });
        }
    });
}

test("Given HTML requests a disallowed resource or throws, When it runs, Then sanitized diagnostics retain source and reload controls", async ({
    runtime,
}, testInfo) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    await runtime.writeFiles(
        new Map([
            [
                "/workspace/delivery-review.html",
                {
                    mediaType: "text/html",
                    content: `<!doctype html><h1>Resource probe</h1>
<button id="load">Load resource</button><p id="result"></p>
<script>
addEventListener("securitypolicyviolation", () => {
    document.getElementById("result").textContent = "Blocked by resource policy";
});
document.getElementById("load").onclick = () => {
    const image = new Image();
    image.src = "https://unapproved.invalid/private-resource.png";
    document.body.append(image);
};
</script>`,
                },
            ],
        ]),
    );
    await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open delivery review" }).click();
    const preview = page.getByRole("dialog", { name: "Local file preview" });
    const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
    await result.getByRole("button", { name: "Load resource" }).click();
    await expect(result.getByText("Blocked by resource policy", { exact: true })).toBeVisible();
    await expect(preview.getByRole("alert")).toContainText(/resource/u);
    await page.screenshot({ path: testInfo.outputPath("html-blocked-resource.png") });
    await preview.getByRole("button", { name: "View source" }).click();
    await expect(preview.getByRole("region", { name: "File contents" })).toContainText("Resource probe");
    await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);

    await runtime.writeFiles(
        new Map([
            [
                "/workspace/delivery-review.html",
                {
                    mediaType: "text/html",
                    content: `<!doctype html><h1>Broken script</h1><script>throw new Error("private error details");</script>`,
                },
            ],
        ]),
    );
    await preview.getByRole("button", { name: "Reload file" }).click();
    await expect(preview.getByRole("alert")).toContainText("script error");
    await expect(preview.getByRole("alert")).not.toContainText("private error details");
    await preview.getByRole("button", { name: "View source" }).click();
    await expect(preview.getByRole("region", { name: "File contents" })).toContainText("Broken script");
});

test("Given HTML tries to weaken its resource policy, When it requests host data or opens another window, Then the browser still blocks those capabilities", async ({
    runtime,
}) => {
    const { page } = runtime;
    await runtime.openPairedChat();
    const hostApi = new URL("/morty/api", page.url()).href;
    await page.context().addCookies([
        {
            name: "preview-boundary",
            value: "host-only-marker",
            url: new URL(page.url()).origin,
            sameSite: "Strict",
        },
    ]);
    await runtime.writeFiles(
        new Map([
            [
                "/workspace/delivery-review.html",
                {
                    mediaType: "text/html",
                    content: `<!doctype html><h1>Policy probe</h1>
<button id="check">Check policy</button><ul id="results"></ul><p id="policy"></p>
<script>
addEventListener("securitypolicyviolation", (event) => {
    if (event.effectiveDirective === "connect-src") {
        document.getElementById("policy").textContent = "Host access denied by resource policy";
    }
});
document.getElementById("check").onclick = async () => {
    const add = (text) => {
        const row = document.createElement("li");
        row.textContent = text;
        document.getElementById("results").append(row);
    };
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    policy.content = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:";
    policy.remove();
    const replacement = document.createElement("meta");
    replacement.httpEquiv = "Content-Security-Policy";
    replacement.content = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:";
    document.head.append(replacement);
    add(window.open("about:blank", "_blank") === null ? "Popup blocked" : "Popup opened");
    try {
        add(document.cookie.includes("host-only-marker") ? "Host cookies accessible" : "Host cookies isolated");
    } catch { add("Host cookies isolated"); }
    try {
        await fetch(${JSON.stringify(hostApi)}, { credentials: "include" });
        add("Host request allowed");
    } catch { add("Host request blocked"); }
};
</script>`,
                },
            ],
        ]),
    );
    await page.getByRole("textbox", { name: "Message" }).fill("show interactive result");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Open delivery review" }).click();
    const result = page.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML content"]');
    await result.getByRole("button", { name: "Check policy" }).click();
    await expect(result.getByRole("listitem")).toHaveText([
        "Popup blocked",
        "Host cookies isolated",
        "Host request blocked",
    ]);
    await expect(result.getByText("Host access denied by resource policy", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("resource");
    await expect(result.getByRole("heading", { name: "Policy probe" })).toBeVisible();
    await page.getByRole("button", { name: "Close file preview" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});
