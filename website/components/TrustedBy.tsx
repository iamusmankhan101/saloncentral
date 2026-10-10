import Image from "next/image";
import styles from "./TrustedBy.module.css";

// `inset`: logos on a white background — keep the whole mark visible and outline the circle.
const LOGOS = [
  { src: "/lounge-8-salon-logo.png", alt: "Lounge 8 Salon" },
  { src: "/sonias-bridal-experts-logo.png", alt: "Sonia's The Bridal Experts" },
  { src: "/HA SALON.png", alt: "HA Salon", inset: true },
  { src: "/misbahs-serenity-spa-salon-logo.jpg", alt: "Misbah's Serenity Spa & Salon" },
  { src: "/makeup-by-sara-logo.jpg", alt: "Makeup by Sara", inset: true },
  { src: "/prestige-salon-logo.jpg", alt: "Prestige Salon & Spa" },
  { src: "/the-velvet-chair-logo.jpg", alt: "The Velvet Chair" },
  { src: "/morning glory logo.png", alt: "Morning Glory" },
];

export default function TrustedBy() {
  return (
    <div className={styles.wrapper}>
      <p className={styles.label} data-animate data-delay="0">Trusted by salons across Pakistan</p>
      <div className={styles.marquee} data-animate data-delay="0.08">
        {/* The list is rendered twice and the track slides by exactly one copy, so the loop has no seam.
            The second copy is decorative only. */}
        <div className={styles.track}>
          {[false, true].map((copy) => (
            <div key={String(copy)} className={styles.logos} aria-hidden={copy || undefined}>
              {LOGOS.map((logo) => (
                <div key={logo.src} className={styles.logoCard}>
                  <Image
                    src={logo.src}
                    alt={copy ? "" : logo.alt}
                    width={500}
                    height={500}
                    className={`${styles.logoImage} ${logo.inset ? styles.logoImageInset : ""}`}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
