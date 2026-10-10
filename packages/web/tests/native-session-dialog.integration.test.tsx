import { getByRole, queryByRole } from "@testing-library/dom";
import { expect, test } from "vitest";
import { dataTestId } from "../src/data-testid.ts";
import "./infra/application-scenario.ts";
import { createTestApp } from "./infra/test-app.tsx";

test("Given native sessions are being discovered, When the user opens Native Sessions, Then a loading placeholder and the preview instruction are visible", {
    timeout: 30_000,
}, async () => {
    const app = await createTestApp({ connectAgent: true });
    await app.queryElementByTestId(
        dataTestId.botConnectionStatus,
        (element) => element.textContent?.includes("Connected") === true,
    );
    const open = getByRole(document.body, "button", { name: "Native Sessions" });
    const loading = app.waitForView(() => {
        const status = queryByRole(document.body, "status", {
            name: "Discovering native sessions",
        });
        if (status === null) {
            throw new Error("The native session loading placeholder is not visible.");
        }
        return status;
    });

    await app.user.click(open);

    await loading;
    const preview = getByRole(document.body, "region", {
        name: "Selected session preview",
    });
    expect(preview.textContent).toContain("Select a session to preview its history.");
});
