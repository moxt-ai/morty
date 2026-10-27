import { ArrowRight, MessageSquare } from "lucide-react";
import type { ComponentType } from "react";
import { Card } from "../../components/ui/card.tsx";
import { NavigationCardLink } from "../../components/ui/navigation-card-link.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";

export function MobiusApplications({
    ChatApplication,
    MortyApplication,
    view: selected,
}: {
    readonly ChatApplication: ComponentType;
    readonly MortyApplication: ComponentType;
    readonly view: "overview" | "chat";
}) {
    return (
        <>
            {selected === "chat" ? (
                <section aria-label="Chat" className="grid min-h-0 min-w-0 flex-1 motion-safe:animate-cloud-enter">
                    <ChatApplication />
                </section>
            ) : (
                <div className="grid min-w-0 items-start gap-6 motion-safe:animate-cloud-enter lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
                    <section aria-label="Morty" className="min-w-0">
                        <MortyApplication />
                    </section>
                    <nav aria-label="Applications" className="grid gap-5">
                        <Card asChild>
                            <NavigationCardLink
                                to="/chat"
                                search={{}}
                                label="Open Chat"
                                className="group p-5 transition-colors hover:bg-accent keyboard-focus:focus-visible:outline-2 keyboard-focus:focus-visible:outline-ring"
                            >
                                {(pending) => (
                                    <>
                                        <h2 className="flex items-center gap-3 text-sm font-semibold">
                                            <MessageSquare aria-hidden="true" className="size-5 text-primary" /> Chat{" "}
                                            <span className="ml-auto">
                                                {pending ? (
                                                    <Spinner label="Opening Chat" />
                                                ) : (
                                                    <ArrowRight
                                                        aria-hidden="true"
                                                        className="ml-auto size-4 text-muted-foreground group-hover:text-foreground"
                                                    />
                                                )}
                                            </span>
                                        </h2>
                                        <p className="mt-2 text-[13px] text-muted-foreground">
                                            Open your local agent sessions.
                                        </p>
                                    </>
                                )}
                            </NavigationCardLink>
                        </Card>
                    </nav>
                </div>
            )}
        </>
    );
}
