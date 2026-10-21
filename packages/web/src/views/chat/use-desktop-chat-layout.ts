import { useEffect, useState } from "react";

const desktopChatLayoutQuery = "(min-width: 640px)";

/** Desktop chat chrome from the `sm` breakpoint up. Tests use happy-dom's default 1024px width. */
export function useDesktopChatLayout(): boolean {
    const [desktop, setDesktop] = useState(() => window.matchMedia(desktopChatLayoutQuery).matches);
    useEffect(() => {
        const media = window.matchMedia(desktopChatLayoutQuery);
        const update = () => setDesktop(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    return desktop;
}
