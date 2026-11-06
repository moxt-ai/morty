/** Whether the address is the Morty component library (playground), which stays on its own routes. */
export function isComponentLibraryPath(pathname: string): boolean {
    return pathname === "/playground" || pathname.startsWith("/playground/");
}
