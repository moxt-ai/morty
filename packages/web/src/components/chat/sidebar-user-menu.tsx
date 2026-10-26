import { LoaderCircle, LogOut, UserRound, Wifi } from "lucide-react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { useRef } from "react";
import { dataTestId } from "../../data-testid.ts";
import { Button } from "../ui/cloud-button.tsx";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";

/**
 * The sidebar account menu. A menu opened by a pointer does not hand focus back
 * to its trigger when it closes, so the trigger's tooltip does not reopen.
 */
export function SidebarUserMenu({
    disabled,
    endAccessDisabled,
    onMeasureNetwork,
    onEndAccess,
}: {
    readonly disabled: boolean;
    readonly endAccessDisabled: boolean;
    readonly onMeasureNetwork: () => void;
    readonly onEndAccess: () => void;
}) {
    const openedByPointer = useRef(false);
    return (
        <DropdownMenu.Root>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>
                    <DropdownMenu.Trigger asChild>
                        <Button
                            aria-label="User menu"
                            className="shrink-0 rounded-full border border-white bg-black/[0.08] text-copy-secondary hover:bg-black/[0.12] active:bg-black/[0.16] data-[state=open]:bg-black/[0.16]"
                            data-testid={dataTestId.userMenu}
                            disabled={disabled}
                            onPointerDown={() => {
                                openedByPointer.current = true;
                            }}
                            size="icon"
                            variant="ghost"
                        >
                            {disabled ? (
                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                            ) : (
                                <UserRound aria-hidden="true" className="size-4" />
                            )}
                        </Button>
                    </DropdownMenu.Trigger>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                    <MortyTooltipContent side="top" sideOffset={6}>
                        User menu
                        <Tooltip.Arrow className="fill-foreground" />
                    </MortyTooltipContent>
                </Tooltip.Portal>
            </Tooltip.Root>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    align="start"
                    className="z-[110] min-w-52 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg"
                    onCloseAutoFocus={(event) => {
                        if (openedByPointer.current) {
                            event.preventDefault();
                        }
                        openedByPointer.current = false;
                    }}
                    side="top"
                    sideOffset={6}
                >
                    <DropdownMenu.Item
                        className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 outline-none data-[highlighted]:bg-accent"
                        onSelect={onMeasureNetwork}
                    >
                        <Wifi aria-hidden="true" className="size-4" />
                        Network latency
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-black/[0.06]" />
                    <DropdownMenu.Item
                        className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-destructive outline-none data-[highlighted]:bg-destructive/10"
                        data-testid={dataTestId.endRemoteAccess}
                        disabled={endAccessDisabled}
                        onSelect={onEndAccess}
                    >
                        <LogOut aria-hidden="true" className="size-4" />
                        End current access
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
