import { dataTestId } from "../../data-testid.ts";
import { setupContentStackClassName } from "../setup/setup-card-shell.tsx";
import { SetupCopyableField } from "../setup/setup-copyable-field.tsx";

export function PairingInstruction() {
    const setupInstruction = `Fetch ${window.location.origin}/setup.md and set up Morty for me. Don't ask me anything.`;
    return (
        <div className={setupContentStackClassName}>
            <SetupCopyableField
                ariaLabel="Agent setup instruction"
                copyButtonLabel="Copy this instruction"
                fieldTestId={dataTestId.pairingInstruction}
                value={setupInstruction}
            />
        </div>
    );
}
