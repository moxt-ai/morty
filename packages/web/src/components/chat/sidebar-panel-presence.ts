import { type TransitionEvent, useEffect, useRef, useState } from "react";

const panelMotionMs = 280;

/**
 * Sidebar panel open/close motion states, purely presentational. Recorded
 * effect exception: the effects only track CSS transition run/finish to time
 * presence — DOM-ephemeral state, no asynchronous workflow.
 */

export function usePanelPresence(open: boolean) {
    const [present, setPresent] = useState(open);
    const [shown, setShown] = useState(open);
    const [animate, setAnimate] = useState(false);
    const openRef = useRef(open);
    const presentRef = useRef(present);
    openRef.current = open;
    presentRef.current = present;
    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setPresent(open);
            setShown(open);
            setAnimate(false);
            return;
        }
        if (!open) {
            setShown(false);
            if (presentRef.current) {
                setAnimate(true);
            }
            return;
        }
        setPresent(true);
        setShown(false);
        setAnimate(false);
        let secondFrame = 0;
        const firstFrame = window.requestAnimationFrame(() => {
            secondFrame = window.requestAnimationFrame(() => {
                if (!openRef.current) {
                    return;
                }
                setAnimate(true);
                setShown(true);
            });
        });
        return () => {
            window.cancelAnimationFrame(firstFrame);
            window.cancelAnimationFrame(secondFrame);
        };
    }, [open]);
    useEffect(() => {
        if (open || !present || shown) {
            return;
        }
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }
        const timeout = window.setTimeout(() => {
            if (!openRef.current) {
                setPresent(false);
                setAnimate(false);
            }
        }, panelMotionMs + 80);
        return () => window.clearTimeout(timeout);
    }, [open, present, shown]);
    const onTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
        if (
            event.target !== event.currentTarget ||
            (event.propertyName !== "transform" && event.propertyName !== "translate") ||
            openRef.current
        ) {
            return;
        }
        setPresent(false);
        setAnimate(false);
    };
    return { present, shown, animate, onTransitionEnd };
}

export const panelMotionClassName =
    "motion-safe:transition-[opacity,transform,translate] motion-safe:duration-[280ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";
