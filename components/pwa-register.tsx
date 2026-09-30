"use client";

/**
 * components/pwa-register.tsx
 *
 * Registers /sw.js once per session. Mounted from the root layout so both the
 * dashboard and the client-facing pages are covered by one registration —
 * the worker's scope is "/", and a second registration at a narrower scope
 * would shadow it.
 *
 * Renders nothing.
 */

import "@/lib/polyfills";
import { useEffect } from "react";

export default function PWARegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // In dev, Next.js serves from a different build each reload; registering
    // there mostly produces confusing stale-worker behaviour, so opt out
    // unless it's explicitly being tested.
    const devOptIn = process.env.NODE_ENV !== "production"
      && new URLSearchParams(window.location.search).has("sw");
    if (process.env.NODE_ENV !== "production" && !devOptIn) return;

    let cancelled = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (cancelled) return;

        // Pick up a newer worker on the next page view rather than forcing a
        // reload mid-appointment: skipWaiting only fires when nothing is
        // currently controlled (i.e. a genuinely first install).
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && !navigator.serviceWorker.controller) {
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });

        // Check for a new deploy when the app is brought back to the foreground.
        const onVisible = () => {
          if (document.visibilityState === "visible") registration.update().catch(() => {});
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
      } catch (err) {
        // A failed registration must never break the page — the app works fine
        // without offline support or push.
        console.warn("[pwa] service worker registration failed:", err);
      }
    };

    register();
    return () => { cancelled = true; };
  }, []);

  return null;
}
