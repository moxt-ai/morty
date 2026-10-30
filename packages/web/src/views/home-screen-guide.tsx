import { MortyLogoMark } from "../components/brand/morty-logo.tsx";
import { Button } from "../components/ui/cloud-button.tsx";
import type { HomeScreenPlatform } from "../view-models/home-screen-guide.ts";

function Instructions({ platform }: { readonly platform: HomeScreenPlatform }) {
    switch (platform) {
        case "ios":
            return (
                <>
                    <p>In Safari or Chrome on your iPhone or iPad:</p>
                    <ol className="list-decimal space-y-3 pl-5 marker:text-muted-foreground">
                        <li>Tap Share, then Add to Home Screen.</li>
                        <li>If Open as Web App appears, turn it off.</li>
                        <li>Keep the name Morty, then tap Add.</li>
                    </ol>
                    <p className="text-muted-foreground">
                        The shortcut opens in your default browser. Make sure Morty is connected there. If it needs
                        access, use Continue on another device in your connected Morty browser.
                    </p>
                </>
            );
        case "android":
            return (
                <>
                    <p>In Chrome on your Android phone:</p>
                    <ol className="list-decimal space-y-3 pl-5 marker:text-muted-foreground">
                        <li>Open the browser menu next to the address bar.</li>
                        <li>Tap Install and create shortcut, then Create shortcut (or Add to Home screen).</li>
                        <li>Keep the name Morty, then tap Add.</li>
                    </ol>
                    <p className="text-muted-foreground">
                        Use the Chrome browser where Morty is connected. If it needs access, use Continue on another
                        device in your connected Morty browser.
                    </p>
                </>
            );
        case "other":
            return (
                <p>
                    Open Morty in Safari or Chrome on iPhone, or Chrome on Android, then choose Add to Home Screen in
                    Morty’s navigation. If that browser needs access, use Continue on another device in your connected
                    Morty browser first.
                </p>
            );
    }
}

export function HomeScreenGuide({ platform }: { readonly platform: HomeScreenPlatform }) {
    return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-8 text-foreground">
            <section aria-labelledby="home-screen-title" className="w-full max-w-sm space-y-6">
                <div className="flex items-center gap-2.5 text-lg font-semibold">
                    <MortyLogoMark size={32} />
                    Morty
                </div>
                <div className="space-y-2">
                    <h1 id="home-screen-title" className="text-2xl font-semibold tracking-tight">
                        Add to Home Screen
                    </h1>
                    <p className="text-sm leading-6 text-muted-foreground">
                        Open Morty quickly from your phone’s home screen.
                    </p>
                </div>
                <div className="space-y-4 text-sm leading-6">
                    <Instructions platform={platform} />
                    {platform !== "other" && (
                        <p className="text-muted-foreground">
                            In another browser or an in-app window? Open this address in the browser above, then choose
                            Add to Home Screen in Morty’s navigation.
                        </p>
                    )}
                </div>
                <div className="space-y-3 border-t border-border pt-5">
                    <p className="text-xs leading-5 text-muted-foreground">
                        Your conversation stays in the previous tab. Close this tab to return to it.
                    </p>
                    <Button asChild className="min-h-11 w-full">
                        <a href="/">Open Morty</a>
                    </Button>
                </div>
            </section>
        </main>
    );
}
