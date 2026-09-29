/**
 * JazzCash and EasyPaisa logos — used wherever a payment method is picked or
 * shown (POS, billing, the client app's payment options) so the customer and
 * the cashier recognise the wallet at a glance instead of reading a generic
 * phone icon.
 *
 * The files in public/logos are the brand symbols only, cropped from the
 * originals in public/ onto a transparent background: at the 17–36px these
 * render at, a wordmark would be unreadable.
 */

/* eslint-disable @next/next/no-img-element -- tiny static icons; next/image adds nothing here */

function Logo({ src, label, size }: { src: string; label: string; size: number }) {
  return (
    <img
      src={src}
      alt={label}
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size, flexShrink: 0, display: "block", objectFit: "contain" }}
    />
  );
}

export function JazzCashLogo({ size = 28 }: { size?: number }) {
  return <Logo src="/logos/jazzcash.png" label="JazzCash" size={size} />;
}

export function EasypaisaLogo({ size = 28 }: { size?: number }) {
  return <Logo src="/logos/easypaisa.png" label="EasyPaisa" size={size} />;
}

/** The logo for a payment-method id, or null when the method has no brand mark. */
export function WalletLogo({ method, size = 28 }: { method: string; size?: number }) {
  if (method === "jazzcash") return <JazzCashLogo size={size} />;
  if (method === "easypaisa") return <EasypaisaLogo size={size} />;
  return null;
}
