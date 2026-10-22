// SVG is displayed only in <img>, whose image context disables scripts and external resources.
// Never embed these files as inline SVG, HTML, an iframe, or an object.
const isRasterImageType = (mediaType: string): boolean => /^image\/(?:gif|jpeg|png|webp)$/u.test(mediaType);
export const isDisplayableImageType = (mediaType: string): boolean =>
    isRasterImageType(mediaType) || mediaType === "image/svg+xml";
