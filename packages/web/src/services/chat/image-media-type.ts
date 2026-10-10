// SVG is displayed only in <img>, whose image context disables scripts and external resources.
// Never embed these files as inline SVG, HTML, an iframe, or an object.
export const isDisplayableImageType = (mediaType: string): boolean =>
    /^image\/(?:gif|jpeg|png|webp|svg\+xml)$/u.test(mediaType);
