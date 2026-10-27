const INPUT_MODALITY_ATTRIBUTE = "data-input-modality";

type InputModality = "keyboard" | "pointer";

/**
 * The browser's focus-visible heuristic also fires for programmatic focus
 * caused by pointer interactions, such as a menu item receiving focus when it
 * opens. Track the last input device so focus styling follows the user's actual
 * navigation method instead.
 */
export function installInputModalityTracking(): void {
    const root = document.documentElement;
    if (root.hasAttribute(INPUT_MODALITY_ATTRIBUTE)) {
        return;
    }
    const setInputModality = (modality: InputModality): void => {
        root.setAttribute(INPUT_MODALITY_ATTRIBUTE, modality);
    };

    // Start in pointer mode so automatic focus during initial rendering does
    // not flash a keyboard-only focus ring.
    setInputModality("pointer");
    window.addEventListener("pointerdown", () => setInputModality("pointer"), {
        capture: true,
        passive: true,
    });
    window.addEventListener("keydown", () => setInputModality("keyboard"), { capture: true });
}
