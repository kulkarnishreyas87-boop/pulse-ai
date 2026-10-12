import { DOMAIN_PHOTOS, creditUrl, photoUrl, type DomainTheme } from "@/lib/theme";
import { DomainArt } from "./DomainArt";

/**
 * The domain's photograph, tinted in the domain's colour so every photo sits inside the page's palette.
 * Falls back to the generated artwork for domains without a photo (for example ones added in Settings).
 */
export function DomainPhoto({ domainId, theme, width = 1200, eager = false, className = "" }: { domainId: string; theme: DomainTheme; width?: number; eager?: boolean; className?: string }) {
  const photo = DOMAIN_PHOTOS[domainId];
  if (!photo) return <DomainArt kind={theme.kind} hue={theme.hue} seed={domainId} className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photoUrl(photo, width)}
      srcSet={`${photoUrl(photo, Math.round(width / 2))} ${Math.round(width / 2)}w, ${photoUrl(photo, width)} ${width}w`}
      sizes={`(max-width: 700px) 100vw, ${width}px`}
      alt={photo.alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={`domain-photo ${className}`}
    />
  );
}

/** "Photo by X on Unsplash", as the Unsplash guidelines ask. Renders nothing for domains without a photo. */
export function PhotoCredit({ domainId, className = "" }: { domainId: string; className?: string }) {
  const photo = DOMAIN_PHOTOS[domainId];
  if (!photo) return null;
  return (
    <p className={`photo-credit ${className}`}>
      Photo by{" "}
      <a href={creditUrl(photo.page)} target="_blank" rel="noreferrer">
        {photo.photographer}
      </a>{" "}
      on{" "}
      <a href={creditUrl("https://unsplash.com")} target="_blank" rel="noreferrer">
        Unsplash
      </a>
    </p>
  );
}
