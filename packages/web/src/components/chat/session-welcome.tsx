import { ArrowUpRight, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/cloud-button";
import { MortyAlert } from "@/components/ui/morty-alert";
import { chatSessionMessageColumnClassName } from "./chat-session-layout.ts";

function welcomeMockRequested(): boolean {
    return new URLSearchParams(window.location.search).get("mockSessionWelcome") === "1";
}

export function SessionWelcomeMock() {
    const [visible, setVisible] = useState(welcomeMockRequested);
    if (!visible) {
        return null;
    }
    return (
        <div className={chatSessionMessageColumnClassName}>
            <SessionWelcome
                canSuggestProgress
                onDismiss={() => setVisible(false)}
                onSuggestProgress={() => setVisible(false)}
            />
        </div>
    );
}

export function SessionWelcomeInChat({
    canSuggestProgress,
    onDismiss,
    onMockSuggestProgress,
    onSuggestProgress,
    visible,
}: {
    readonly canSuggestProgress: boolean;
    readonly onDismiss: () => void;
    readonly onMockSuggestProgress: () => void;
    readonly onSuggestProgress: () => void;
    readonly visible: boolean;
}) {
    const [showMock, setShowMock] = useState(welcomeMockRequested);
    if (!visible && !showMock) {
        return null;
    }
    return (
        <SessionWelcome
            canSuggestProgress={showMock || canSuggestProgress}
            onDismiss={() => {
                setShowMock(false);
                if (visible) {
                    onDismiss();
                }
            }}
            onSuggestProgress={() => {
                if (showMock) {
                    setShowMock(false);
                    if (canSuggestProgress) {
                        onMockSuggestProgress();
                    }
                    if (visible) {
                        onDismiss();
                    }
                    return;
                }
                onSuggestProgress();
            }}
        />
    );
}

export function SessionWelcome({
    canSuggestProgress,
    onDismiss,
    onSuggestProgress,
}: {
    readonly canSuggestProgress: boolean;
    readonly onDismiss: () => void;
    readonly onSuggestProgress: () => void;
}) {
    return (
        <section aria-label="Continue your work here" className="relative">
            <MortyAlert
                className="border-white pr-10"
                description={
                    <>
                        Check its progress, send your next instruction, or respond to requests here.
                        {canSuggestProgress && (
                            <div className="mt-3">
                                <Button onClick={onSuggestProgress} size="sm" variant="primary">
                                    Ask for a progress update
                                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                                </Button>
                                <p className="mt-1.5">Adds a draft for you to review and send.</p>
                            </div>
                        )}
                    </>
                }
                tone="info"
            >
                Your original session is open.
            </MortyAlert>
            <Button
                aria-label="Dismiss getting started tip"
                className="absolute top-1.5 right-1.5 text-muted-foreground"
                onClick={onDismiss}
                size="icon"
                variant="ghost"
            >
                <X aria-hidden="true" className="size-4" />
            </Button>
        </section>
    );
}
