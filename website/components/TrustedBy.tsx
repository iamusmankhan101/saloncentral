import Image from "next/image";
import styles from "./TrustedBy.module.css";

export default function TrustedBy() {
  return (
    <div className={styles.wrapper}>
      <p className={styles.label} data-animate data-delay="0">Trusted by salons across Pakistan</p>
      <div className={styles.logos}>
        <div className={styles.logoCard} data-animate data-delay="0.08">
          <Image
            src="/lounge-8-salon-logo.png"
            alt="Lounge 8 Salon"
            width={500}
            height={500}
            className={styles.logoImage}
          />
        </div>
        <div className={styles.logoCard} data-animate data-delay="0.16">
          <Image
            src="/sonias-bridal-experts-logo.png"
            alt="Sonia's The Bridal Experts"
            width={500}
            height={500}
            className={styles.logoImage}
          />
        </div>
        <div className={styles.logoCard} data-animate data-delay="0.24">
          <Image
            src="/HA SALON.png"
            alt="HA Salon"
            width={500}
            height={500}
            className={`${styles.logoImage} ${styles.logoImageInset}`}
          />
        </div>
        <div className={styles.logoCard} data-animate data-delay="0.32">
          <Image
            src="/misbahs-serenity-spa-salon-logo.jpg"
            alt="Misbah's Serenity Spa &amp; Salon"
            width={500}
            height={500}
            className={styles.logoImage}
          />
        </div>
        <div className={styles.logoCard} data-animate data-delay="0.40">
          <Image
            src="/makeup-by-sara-logo.jpg"
            alt="Makeup by Sara"
            width={420}
            height={420}
            className={`${styles.logoImage} ${styles.logoImageInset}`}
          />
        </div>
        <div className={styles.logoCard} data-animate data-delay="0.48">
          <Image
            src="/prestige-salon-logo.jpg"
            alt="Prestige Salon &amp; Spa"
            width={500}
            height={500}
            className={styles.logoImage}
          />
        </div>
        <div className={styles.logoCard} data-animate data-delay="0.56">
          <Image
            src="/the-velvet-chair-logo.jpg"
            alt="The Velvet Chair"
            width={500}
            height={500}
            className={styles.logoImage}
          />
        </div>
      </div>
    </div>
  );
}
