import { useEffect, useState } from "react";

const desktopQuery = "(min-width: 640px)";
const touchQuery = "(pointer: coarse)";

type ConfigurationViewport = {
    readonly desktop: boolean;
    readonly height: number;
    readonly bottom: number;
};

function readViewport(): ConfigurationViewport {
    const viewport = window.visualViewport;
    return {
        desktop: window.matchMedia(desktopQuery).matches && !window.matchMedia(touchQuery).matches,
        height: Math.max(0, (viewport?.height ?? window.innerHeight) - 16),
        bottom: Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0)),
    };
}

/** Keep the sheet above the software keyboard, including after touch-device rotation. */
export function useConfigurationViewport() {
    const [viewport, setViewport] = useState(readViewport);
    useEffect(() => {
        const desktop = window.matchMedia(desktopQuery);
        const touch = window.matchMedia(touchQuery);
        const visible = window.visualViewport;
        const update = () => setViewport(readViewport());
        desktop.addEventListener("change", update);
        touch.addEventListener("change", update);
        window.addEventListener("resize", update);
        visible?.addEventListener("resize", update);
        visible?.addEventListener("scroll", update);
        update();
        return () => {
            desktop.removeEventListener("change", update);
            touch.removeEventListener("change", update);
            window.removeEventListener("resize", update);
            visible?.removeEventListener("resize", update);
            visible?.removeEventListener("scroll", update);
        };
    }, []);
    return viewport;
}
