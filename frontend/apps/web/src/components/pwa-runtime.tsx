"use client";

import { useEffect } from "react";

const buildId = process.env.NEXT_PUBLIC_FABUSHI_BUILD_ID?.trim() || "dev";

function basePath(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_BASE_PATH?.trim() || "";
  const normalized = raw.split("/").filter(Boolean).join("/");
  return normalized ? `/${normalized}` : "";
}

function agentRunIsActive(): boolean {
  return document.querySelector('button[aria-label="停止任务"]') !== null;
}

export function PwaRuntime() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) return;

    let disposed = false;
    let hadController = Boolean(navigator.serviceWorker.controller);
    let activationTimer: ReturnType<typeof setTimeout> | null = null;

    const onControllerChange = () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const activateWhenSafe = (registration: ServiceWorkerRegistration) => {
      if (disposed || !registration.waiting) return;
      if (agentRunIsActive()) {
        activationTimer = window.setTimeout(() => activateWhenSafe(registration), 1000);
        return;
      }
      registration.waiting.postMessage({ type: "SKIP_WAITING", version: buildId });
    };

    void (async () => {
      const prefix = basePath();
      const scriptUrl = `${prefix}/sw.js?v=${encodeURIComponent(buildId)}`;
      const scope = `${prefix || ""}/`;
      const registration = await navigator.serviceWorker.register(scriptUrl, {
        scope,
        updateViaCache: "none",
      });
      if (disposed) return;

      activateWhenSafe(registration);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) activateWhenSafe(registration);
        });
      });
      await registration.update();
    })().catch((error) => {
      console.error("Fabushi PWA registration failed", error);
    });

    return () => {
      disposed = true;
      if (activationTimer) clearTimeout(activationTimer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
