import { runAgentImageE2E } from "./agent-image-live.mjs";
import { prepareOpenCode } from "./opencode.mjs";

await runAgentImageE2E({
    answer: "Generated the requested image through OpenCode and the local fake LLM provider.",
    expectedTool: { kind: "function", name: "mobius_image_generate_geometric_png" },
    model: "mobius-image-e2e",
    name: "opencode-e2e",
    prepareAgent: prepareOpenCode,
    prompt: "Generate one PNG with the available image tool.",
    providerOptions: { toolPreference: { name: /image/iu } },
});
