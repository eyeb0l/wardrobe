import { forwardRef } from "react";
import { Image } from "@unpic/react";
import { DISPLAY_WIDTHS, displayImageSource } from "../shared/image-variants.mjs";

const IPX_OPTIONS = { ipx: { baseURL: "/_ipx" } };
const DEFAULT_BREAKPOINTS = [160, 240, 320, 480, 640, 800, 960, 1280];

function sourcePath(src) {
  if (!src || typeof src !== "string") return src;
  return src.split(/[?#]/, 1)[0];
}

export const OptimizedImage = forwardRef(function OptimizedImage({
  src,
  alt = "",
  sizes = "100vw",
  breakpoints = DEFAULT_BREAKPOINTS,
  quality = 80,
  priority = false,
  loading,
  decoding,
  unoptimized = false,
  ...props
}, ref) {
  const normalizedSource = sourcePath(src);
  const displaySource = !unoptimized && displayImageSource(src);
  if (displaySource) {
    return <img ref={ref} src={displaySource} srcSet={DISPLAY_WIDTHS.map(width => `${displayImageSource(src, width)} ${width}w`).join(", ")}
      alt={alt} sizes={sizes} loading={loading || (priority ? "eager" : "lazy")} decoding={decoding || "async"} {...props} />;
  }

  if (unoptimized || !normalizedSource || normalizedSource.startsWith("data:") || normalizedSource.startsWith("blob:") || normalizedSource.startsWith("/api/")) {
    return <img ref={ref} src={src} alt={alt} sizes={sizes} loading={loading || (priority ? "eager" : "lazy")} decoding={decoding || "async"} {...props} />;
  }

  return (
    <Image
      ref={ref}
      src={normalizedSource}
      alt={alt}
      fallback="ipx"
      options={IPX_OPTIONS}
      operations={{ ipx: { quality } }}
      layout="fullWidth"
      unstyled
      sizes={sizes}
      breakpoints={breakpoints}
      priority={priority}
      loading={loading}
      decoding={decoding}
      {...props}
    />
  );
});
