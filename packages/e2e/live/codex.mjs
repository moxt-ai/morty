import { join } from "node:path";
import { runAgentImageE2E } from "./agent-image.mjs";
import { prepareCodexAgent } from "./codex-agent.mjs";

const generatedImage = (harness) =>
    join(harness.workDirectory, "codex-home", "generated_images", "mobius-e2e", "geometric.png");
const markdown = (harness) => `![Codex generated geometric PNG](${generatedImage(harness)})`;

await runAgentImageE2E({
    answer: markdown,
    expectedTool: { kind: "custom", name: "exec" },
    model: "gpt-5.6-sol",
    name: "codex-e2e",
    prepareAgent: prepareCodexAgent,
    prompt: "Generate one PNG with the available image tool.",
    providerOptions: (harness) => {
        const path = generatedImage(harness);
        return {
            firstAnswer: "Codex native session ready.",
            // Split the Markdown image across provider deltas so Codex ACP emits the same
            // streaming shape observed from production image generation.
            textChunks: ["![Codex generated geometric PNG](", path, ")"],
            toolPreference: {
                name: /image/iu,
                customInput: [
                    "const result = await tools.mcp__mobius_image__generate_geometric_png({});",
                    'text(result.content.map((item) => item.text ?? "").join(""));',
                ].join("\n"),
            },
        };
    },
});
