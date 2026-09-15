import type { ReactNode } from "react";

export function ComposerSurface({ children }: { readonly children: ReactNode }) {
    return (
        <div className="flex items-end gap-3 rounded-[22px] border border-[#cbd8d0] bg-white p-3 shadow-[0_6px_24px_rgb(24_49_35/6%)] transition-[border-color,box-shadow] duration-150 focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgb(34_123_78/9%),0_6px_24px_rgb(24_49_35/6%)] motion-reduce:transition-none sm:p-4">
            {children}
        </div>
    );
}
