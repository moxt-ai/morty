import type { AuthenticationGuidance } from "../../components/chat/authentication-notice.tsx";

export function authenticationGuidance(
    code: string,
    agentRef: string,
    machineName: string,
): AuthenticationGuidance | null {
    if (code !== "authentication_required") {
        return null;
    }
    const computer =
        machineName.trim().length === 0 || machineName === "Unknown"
            ? "the computer running this agent"
            : `“${machineName}”`;
    const firstStep = `Open a terminal on ${computer}, using the same computer account that runs this agent.`;
    const lastStep = "Return here and send your message again when authentication is complete.";
    switch (agentRef) {
        case "claude":
            return {
                title: "Claude Code needs sign-in",
                description: `Open Claude Code on ${computer} and sign in, then return here to send your message again.`,
                steps: [
                    firstStep,
                    "Run claude, then enter /login and follow the sign-in instructions. If you use an API key, check the credentials configured for Claude Code instead.",
                    lastStep,
                ],
            };
        case "codex":
            return {
                title: "Codex needs authentication",
                description: `Check Codex's sign-in or API key on ${computer}, then return here to send your message again.`,
                steps: [
                    firstStep,
                    "Run codex login to sign in. If you use an API key, check the credentials configured for Codex instead.",
                    lastStep,
                ],
            };
        case "pi":
            return {
                title: "Pi's model provider needs authentication",
                description: `Open Pi on ${computer} and check the current model provider's sign-in or API key, then send your message again.`,
                steps: [
                    firstStep,
                    "Run pi, then enter /login and select your model provider. If you use an API key, check the key configured for the current provider instead.",
                    lastStep,
                ],
            };
        default:
            return {
                title: "Your agent needs authentication",
                description: `Check the agent's sign-in or API key on ${computer}, then return here to send your message again.`,
                steps: [firstStep, "Open the agent and check its authentication settings.", lastStep],
            };
    }
}
