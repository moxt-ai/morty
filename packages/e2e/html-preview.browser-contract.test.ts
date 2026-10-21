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
    check("Parent storage", () => parent.localStorage.length);
    check("Frame storage", () => localStorage.length);
    check("Parent API", () => parent.fetch);
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
    const result = page.frameLocator('iframe[title="HTML preview"]');
    await result.getByRole("button", { name: "Check boundary" }).click();
    await expect(result.getByRole("listitem")).toHaveText([
        "Parent document blocked",
        "Parent storage blocked",
        "Frame storage blocked",
        "Parent API blocked",
        "Top navigation blocked",
    ]);
    await expect(page).toHaveURL(hostUrl);
    await expect(preview.getByRole("alert")).toHaveCount(0);
    await preview.getByRole("button", { name: "Close file preview" }).click();
    await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message" }).fill("The host remains usable");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

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
    const result = page.frameLocator('iframe[title="HTML preview"]');
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
<form action="${hostApi}" method="post"><button type="submit">Submit outside preview</button></form>
<script>
addEventListener("securitypolicyviolation", (event) => {
    if (event.effectiveDirective === "connect-src") {
        document.getElementById("policy").textContent = "Host access denied by resource policy";
    } else if (event.effectiveDirective === "form-action") {
        document.getElementById("policy").textContent = "Form submission denied by resource policy";
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
    const result = page.frameLocator('iframe[title="HTML preview"]');
    await result.getByRole("button", { name: "Check policy" }).click();
    await expect(result.getByRole("listitem")).toHaveText([
        "Popup blocked",
        "Host cookies isolated",
        "Host request blocked",
    ]);
    await expect(result.getByText("Host access denied by resource policy", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("resource");
    await result.getByRole("button", { name: "Submit outside preview" }).press("Enter");
    await expect(result.getByText("Form submission denied by resource policy", { exact: true })).toBeVisible();
    await expect(result.getByRole("heading", { name: "Policy probe" })).toBeVisible();
    await page.getByRole("button", { name: "Close file preview" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});
