import { type ComponentProps, useEffect, useState } from "react";

/**
 * Renders a file-backed image through an object URL revoked on unmount or
 * source change. Exception to the no-effect-in-views rule, recorded here for
 * maintainers: the effect only manages this <img> element's own blob URL —
 * pure DOM-ephemeral resource cleanup with no asynchronous workflow, no
 * cancellation, and no view-model state; the owning store (the bug-report
 * dialog) keeps the File itself.
 */
export function ObjectUrlImage({ file, ...image }: { readonly file: File } & ComponentProps<"img">) {
    const [source, setSource] = useState("");
    useEffect(() => {
        const url = URL.createObjectURL(file);
        setSource(url);
        return () => URL.revokeObjectURL(url);
    }, [file]);
    return <img alt={file.name} src={source} {...image} />;
}
