import {
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  type ControlUiEnvironment,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createControlUiFaviconComposer } from "./control-ui-favicon.ts";
import { applyControlUiOperatorSeamColor } from "./control-ui-presentation.ts";

export function applyControlUiPresentation(params: {
  environment: ControlUiEnvironment | null;
  seamColor?: string;
}): void {
  applyControlUiOperatorSeamColor(params.seamColor);
  const root = document.documentElement;
  const environment = params.environment;
  if (!environment) {
    const previous = root.getAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
    if (previous) {
      const previousEnvironment: ControlUiEnvironment = JSON.parse(previous);
      const suffix = ` · ${previousEnvironment.label}`;
      if (document.title.endsWith(suffix)) {
        document.title = document.title.slice(0, -suffix.length);
      }
    }
    root.removeAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
    root.style.removeProperty("--control-ui-environment-color");
    root.style.removeProperty("--control-ui-environment-ink");
    document.querySelector(".control-ui-environment-stripe")?.remove();
    syncControlUiFavicon();
    return;
  }
  root.setAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE, JSON.stringify(environment));
  root.style.setProperty(
    "--control-ui-environment-color",
    `var(--control-ui-environment-${environment.color})`,
  );
  root.style.setProperty(
    "--control-ui-environment-ink",
    `var(--control-ui-environment-${environment.color}-ink)`,
  );
  if (!document.querySelector(".control-ui-environment-stripe")) {
    const stripe = document.createElement("div");
    stripe.className = "control-ui-environment-stripe";
    stripe.setAttribute("aria-hidden", "true");
    document.body.prepend(stripe);
  }
  if (!document.title.endsWith(` · ${environment.label}`)) {
    document.title = `${document.title} · ${environment.label}`;
  }

  syncControlUiFavicon();
}

export type ControlUiFaviconStatus = "attention" | "working" | "done" | "disconnected" | "idle";

let faviconStatus: ControlUiFaviconStatus = "idle";
let composeFavicon: ReturnType<typeof createControlUiFaviconComposer> | undefined;
const faviconRequests = new WeakMap<HTMLLinkElement, { signature: string }>();
const statusTokens = {
  attention: "--warn",
  working: "--accent",
  done: "--ok",
  disconnected: "--muted",
} as const;

export function applyControlUiFaviconStatus(status: ControlUiFaviconStatus): void {
  faviconStatus = status;
  syncControlUiFavicon();
}

function restoreFavicon(icon: HTMLLinkElement, original: [string | null, string | null]) {
  for (const [attribute, value] of [
    ["href", original[0]],
    ["type", original[1]],
  ] as const) {
    if (value === null) {
      icon.removeAttribute(attribute);
    } else {
      icon.setAttribute(attribute, value);
    }
  }
}

function syncControlUiFavicon(): void {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const environmentValue = root.getAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
  const environment: ControlUiEnvironment | null = environmentValue
    ? JSON.parse(environmentValue)
    : null;
  const environmentColor = environment
    ? style.getPropertyValue(`--control-ui-environment-${environment.color}`).trim()
    : "";
  const environmentSvg = environmentColor
    ? `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path fill="${environmentColor}" d="M60 10C30 10 15 35 15 55c0 20 15 40 30 45v10h10v-10h10v10h10v-10c15-5 30-25 30-45 0-20-15-45-45-45Z"/></svg>`)}`
    : null;
  const color =
    faviconStatus === "idle" ? "" : style.getPropertyValue(statusTokens[faviconStatus]).trim();
  const ring = style.getPropertyValue("--bg").trim();
  if (!color) {
    composeFavicon = undefined;
  }
  for (const icon of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    if (!environmentSvg && !color) {
      faviconRequests.delete(icon);
      if (icon.dataset.openclawOriginalFavicon) {
        restoreFavicon(icon, JSON.parse(icon.dataset.openclawOriginalFavicon));
        delete icon.dataset.openclawOriginalFavicon;
      }
      continue;
    }
    icon.dataset.openclawOriginalFavicon ??= JSON.stringify([
      icon.getAttribute("href"),
      icon.getAttribute("type"),
    ]);
    const original: [string | null, string | null] = JSON.parse(
      icon.dataset.openclawOriginalFavicon,
    );
    const href = environmentSvg ?? original[0];
    const type = environmentSvg ? "image/svg+xml" : original[1];
    const signature = JSON.stringify([href, type, color, ring]);
    if (faviconRequests.get(icon)?.signature === signature) {
      continue;
    }
    const request = { signature };
    faviconRequests.set(icon, request);
    if (!color || !href) {
      restoreFavicon(icon, [href, type]);
      continue;
    }
    composeFavicon ??= createControlUiFaviconComposer();
    void composeFavicon({ href, type, color, ring }).then(
      (result) => {
        // Asset decoding may finish after idle, a palette change, or a context teardown.
        if (icon.isConnected && faviconRequests.get(icon) === request) {
          icon.href = result.href;
          icon.type = result.type;
        }
      },
      (error: unknown) => {
        if (faviconRequests.get(icon) === request) {
          faviconRequests.delete(icon);
          restoreFavicon(icon, [href, type]);
          console.warn("[openclaw] favicon status could not be composed", error);
        }
      },
    );
  }
}
