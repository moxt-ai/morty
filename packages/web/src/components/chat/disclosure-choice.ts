export type DisclosureChoice = "collapsed" | "expanded" | "unset";

/** A user's explicit disclosure choice overrides the status-derived default. */
export function disclosureOpen(choice: DisclosureChoice, defaultOpen: boolean): boolean {
    return choice === "expanded" || (choice === "unset" && defaultOpen);
}
