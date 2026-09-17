import { runAgentImageE2E } from "./agent-image-live.mjs";
import { prepareCodex } from "./codex.mjs";

await runAgentImageE2E({
    answer: "Generated the requested image through Codex and the local fake LLM provider.",
    expectedTool: { kind: "custom", name: "exec" },
    model: "gpt-5.6-sol",
    name: "codex-e2e",
    prepareAgent: prepareCodex,
    prompt: "Generate one PNG with the available image tool.",
    providerOptions: {
        toolPreference: {
            name: /image/iu,
            // Mirrors the observed production Codex path: exec calls an image tool, then publishes its result.
            customInput: [
                "const result = await tools.mcp__mobius_image__generate_geometric_png({});",
                'const image = result.content.find((item) => item.type === "image");',
                'generatedImage({ image_url: "data:" + image.mimeType + ";base64," + image.data });',
            ].join("\n"),
        },
    },
});
