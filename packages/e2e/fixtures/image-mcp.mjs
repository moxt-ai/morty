import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { geometricPng } from "./geometric-png.mjs";

function reply(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) {
        return;
    }
    if (request.method === "initialize") {
        reply(request.id, {
            protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mobius-image-e2e", version: "1.0.0" },
        });
        return;
    }
    if (request.method === "tools/list") {
        reply(request.id, {
            tools: [
                {
                    name: "generate_geometric_png",
                    description: "Generate a deterministic 96 by 96 PNG containing blue and orange geometric shapes.",
                    inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
            ],
        });
        return;
    }
    if (request.method === "tools/call" && request.params?.name === "generate_geometric_png") {
        const outputPath = process.env.MOBIUS_IMAGE_OUTPUT_PATH;
        if (outputPath !== undefined) {
            await mkdir(dirname(outputPath), { recursive: true });
            await writeFile(outputPath, Buffer.from(geometricPng, "base64"));
            reply(request.id, {
                content: [{ type: "text", text: `Generated the geometric PNG at ${outputPath}` }],
            });
            return;
        }
        reply(request.id, {
            content: [
                { type: "image", data: geometricPng, mimeType: "image/png" },
                { type: "text", text: "Generated the geometric PNG." },
            ],
        });
        return;
    }
    if (request.method === "ping") {
        reply(request.id, {});
        return;
    }
    process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
    );
});
