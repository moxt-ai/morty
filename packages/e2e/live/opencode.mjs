import { runAgentImageE2E } from "./agent-image.mjs";
import { prepareOpenCodeAgent } from "./opencode-agent.mjs";

await runAgentImageE2E({
    answer: "Generated the requested image through OpenCode and the local fake LLM provider.",
    expectedTool: { kind: "function", name: "mobius_image_generate_geometric_png" },
    model: "mobius-image-e2e",
    name: "opencode-e2e",
    prepareAgent: prepareOpenCodeAgent,
    prompt: "Generate one PNG with the available image tool.",
    providerOptions: { toolPreference: { name: /image/iu } },
});
