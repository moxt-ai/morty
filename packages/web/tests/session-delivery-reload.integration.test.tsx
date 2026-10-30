import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { expect, onTestFinished, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import { sendPrompt } from "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";
import { TestClock } from "./infra/test-clock.ts";
import { createChatWorkerEnvironment } from "./support/chat-worker.ts";

for (const target of ["immediate", "queued"] as const) {
    for (const interruption of ["before-acceptance", "after-acceptance"] as const) {
        test(`Given an unconfirmed ${target} message disconnected ${interruption}, When I reload and recover it, Then its original request executes once and my next draft survives`, {
            timeout: 60_000,
        }, async () => {
            const environment = await createChatWorkerEnvironment(true);
            onTestFinished(() => environment.close());
            const clock = new TestClock("2026-10-30T08:00:00Z");
            const app = await createTestApp({ environment, connectAgent: true, clock });
            const { network, daemon } = app;
            if (network === null || daemon === null) {
                throw new Error("Expected the controllable network and real Runtime");
            }
            await sendPrompt(
                app,
                await app.queryElementByTestId(dataTestId.messageComposer),
                target === "queued" ? "wait for steering" : "Established session",
            );
            if (target === "queued") {
                await app.queryElementByTestId(dataTestId.sessionStatus);
            } else {
                await app.waitForView(() => {
                    expect(app.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                        "Established session",
                    );
                    expect(app.optionalElementByTestId(dataTestId.workingIndicator)).toBeNull();
                });
            }
            await app.user.upload(
                getByLabelText(document.body, "Choose attachments"),
                new File(["Retain the uploaded file"], "recovery.json", { type: "application/json" }),
            );
            await app.waitForView(() =>
                expect(getByRole(document.body, "list", { name: "Attachments" }).textContent).toContain(
                    "recovery.json",
                ),
            );
            network.interruptNextTurn(interruption);
            await sendPrompt(
                app,
                await app.queryElementByTestId(dataTestId.messageComposer),
                "Keep the original submission",
            );
            await app.waitForView(() =>
                getByRole(document.body, "button", { name: "Retry message with unknown delivery" }),
            );
            const original = JSON.parse(network.submissions.at(-1) ?? "{}");
            const submissions = network.submissions.length;
            await app.user.click(app.elementByTestId(dataTestId.messageComposer));
            await app.user.paste("Next draft survives reload");
            network.reconnect();
            const reloaded = await app.reload();
            await reloaded.waitForView(() =>
                expect(
                    getByRole(document.body, "button", {
                        name: /Switch computer/,
                        description: "Connection available",
                    }),
                ).toBeTruthy(),
            );
            expect(network.submissions).toHaveLength(submissions);
            expect(reloaded.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
                "value",
                "Next draft survives reload",
            );
            if (interruption === "before-acceptance") {
                const retry = await reloaded.waitForView(() => {
                    const button = getByRole(document.body, "button", { name: "Retry message with unknown delivery" });
                    expect(button.hasAttribute("disabled")).toBe(false);
                    expect(document.body.textContent).toContain("recovery.json");
                    return button;
                });
                await reloaded.user.click(retry);
            }
            await reloaded.waitForView(() => {
                expect(
                    queryByRole(document.body, "button", { name: "Retry message with unknown delivery" }),
                ).toBeNull();
                if (target === "queued") {
                    expect(
                        reloaded.elementsByTestId(dataTestId.queuedMessage).map((element) => element.textContent),
                    ).toEqual(["Keep the original submission"]);
                } else {
                    expect(reloaded.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                        "Keep the original submission",
                    );
                }
            });
            expect(network.submissions).toHaveLength(submissions + (interruption === "before-acceptance" ? 1 : 0));
            expect(JSON.parse(network.submissions.at(-1) ?? "{}")).toEqual(original);
            expect(original.attachments).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "recovery.json" })]),
            );
            if (target === "queued") {
                await daemon.continueReply("wait for steering", { outcome: "complete", output: [] });
                await reloaded.waitForView(() =>
                    expect(reloaded.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                        "Keep the original submission",
                    ),
                );
            }
            const settled = await reloaded.reload();
            await settled.waitForView(() =>
                expect(settled.elementsByTestId(dataTestId.agentResponse).at(-1)?.textContent).toContain(
                    "Keep the original submission",
                ),
            );
            expect(queryByRole(document.body, "button", { name: "Retry message with unknown delivery" })).toBeNull();
            expect(
                settled
                    .elementsByTestId(dataTestId.userMessage)
                    .filter((element) => element.textContent?.includes("Keep the original submission")),
            ).toHaveLength(1);
            expect(settled.elementByTestId(dataTestId.messageComposer)).toHaveProperty(
                "value",
                "Next draft survives reload",
            );
        });
    }
}
