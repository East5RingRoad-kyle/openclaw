import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.ts";
import {
  applyControlUiFaviconStatus,
  applyControlUiPresentation,
} from "./control-ui-environment-presentation.runtime.ts";
import { createControlUiFaviconComposer } from "./control-ui-favicon.ts";

let faviconSvg: string;
beforeAll(async () => {
  // Vitest serves its own /favicon.svg; load the shipped asset from the UI root.
  faviconSvg = await commands.readFile("public/favicon.svg", "utf8");
});

const colors = { color: "rgb(80, 120, 160)", ring: "rgb(240, 240, 240)" };

describe("favicon composition", () => {
  it("keeps the animated SVG artwork inline and decodable after composing successive states", async () => {
    const compose = createControlUiFaviconComposer();
    const original = new DOMParser().parseFromString(faviconSvg, "image/svg+xml");
    const href = `data:image/svg+xml,${encodeURIComponent(faviconSvg)}`;
    for (const color of [colors.color, "rgb(120, 180, 100)"]) {
      const result = await compose({ href, type: "image/svg+xml", ...colors, color });
      expect(result.type).toBe("image/svg+xml");
      const parsed = new DOMParser().parseFromString(
        await (await fetch(result.href)).text(),
        "image/svg+xml",
      );
      const animations = (element: Document) =>
        Array.from(element.querySelectorAll("animate, animateTransform"), (animation) =>
          new XMLSerializer().serializeToString(animation),
        );
      expect(animations(parsed)).toEqual(animations(original));
      expect(animations(parsed).length).toBeGreaterThan(0);
      const image = new Image();
      image.src = result.href;
      await image.decode();
      expect([image.naturalWidth, image.naturalHeight]).toEqual([32, 32]);
    }
  });

  it("produces a decodable 32px PNG from a raster favicon", async () => {
    const source = document.createElement("canvas");
    source.width = 48;
    source.height = 48;
    const result = await createControlUiFaviconComposer()({
      href: source.toDataURL("image/png"),
      type: "image/png",
      ...colors,
    });
    expect(result.type).toBe("image/png");
    const image = new Image();
    image.src = result.href;
    await image.decode();
    expect([image.naturalWidth, image.naturalHeight]).toEqual([32, 32]);
  });

  it.each(["image/svg+xml", "image/png"])("rejects an invalid %s source", async (type) => {
    await expect(
      createControlUiFaviconComposer()({ href: `data:${type},invalid`, type, ...colors }),
    ).rejects.toThrow();
  });
});

describe("favicon presentation ownership", () => {
  let previousIcons: HTMLLinkElement[];
  let previousTitle: string;
  let previousStyle: string | null;
  let palette: HTMLStyleElement;
  let svgIcon: HTMLLinkElement;
  let pngIcon: HTMLLinkElement;
  let originals: [[string, string], [string, string]];

  beforeEach(() => {
    previousIcons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
    previousIcons.forEach((icon) => icon.remove());
    previousTitle = document.title;
    previousStyle = document.documentElement.getAttribute("style");
    palette = document.createElement("style");
    palette.textContent = `:root {
      --warn: rgb(210, 150, 60);
      --accent: rgb(80, 120, 160);
      --ok: rgb(100, 180, 120);
      --muted: rgb(130, 130, 130);
      --bg: rgb(240, 240, 240);
      --control-ui-environment-blue: rgb(40, 100, 180);
    }`;
    document.head.append(palette);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    originals = [
      [`data:image/svg+xml,${encodeURIComponent(faviconSvg)}`, "image/svg+xml"],
      [canvas.toDataURL("image/png"), "image/png"],
    ];
    const createIcon = ([href, type]: [string, string]) => {
      const icon = document.createElement("link");
      icon.rel = "icon";
      icon.setAttribute("href", href);
      icon.setAttribute("type", type);
      document.head.append(icon);
      return icon;
    };
    svgIcon = createIcon(originals[0]);
    pngIcon = createIcon(originals[1]);
  });

  afterEach(() => {
    applyControlUiFaviconStatus("idle");
    applyControlUiPresentation({ environment: null });
    svgIcon.remove();
    pngIcon.remove();
    palette.remove();
    document.head.append(...previousIcons);
    document.title = previousTitle;
    if (previousStyle === null) {
      document.documentElement.removeAttribute("style");
    } else {
      document.documentElement.setAttribute("style", previousStyle);
    }
    vi.restoreAllMocks();
  });

  function expectOriginals() {
    [svgIcon, pngIcon].forEach((icon, index) => {
      expect([icon.getAttribute("href"), icon.getAttribute("type")]).toEqual(originals[index]);
      expect(icon.hasAttribute("data-openclaw-original-favicon")).toBe(false);
    });
  }

  function svgDocument() {
    return new DOMParser().parseFromString(
      decodeURIComponent(svgIcon.href.slice("data:image/svg+xml,".length)),
      "image/svg+xml",
    );
  }

  it("updates both icon formats and restores their exact originals when idle without changing the title", async () => {
    applyControlUiFaviconStatus("working");
    await vi.waitFor(() => {
      for (const [icon, [href, type]] of [
        [svgIcon, originals[0]],
        [pngIcon, originals[1]],
      ] as const) {
        expect(icon.getAttribute("href")).not.toBe(href);
        expect(icon.type).toBe(type);
      }
    });
    for (const icon of [svgIcon, pngIcon]) {
      const image = new Image();
      image.src = icon.href;
      await image.decode();
      expect(image.naturalWidth).toBe(32);
    }
    expect(document.title).toBe(previousTitle);
    applyControlUiFaviconStatus("idle");
    expectOriginals();
  });

  it("preserves each active presentation when the environment or status is independently removed", async () => {
    const environment = { label: "Preview", color: "blue" } as const;
    applyControlUiPresentation({ environment });
    const environmentHref = svgIcon.href;
    applyControlUiFaviconStatus("attention");
    await vi.waitFor(() => {
      expect(svgIcon.href).not.toBe(environmentHref);
      expect(svgDocument().documentElement.lastElementChild?.getAttribute("fill")).toBe(
        "rgb(210, 150, 60)",
      );
    });
    const environmentWithStatus = svgIcon.href;
    applyControlUiPresentation({ environment: null });
    await vi.waitFor(() => {
      expect(svgIcon.href).not.toBe(environmentWithStatus);
      expect(svgDocument().querySelectorAll("animate, animateTransform").length).toBeGreaterThan(0);
      expect(svgDocument().documentElement.lastElementChild?.getAttribute("fill")).toBe(
        "rgb(210, 150, 60)",
      );
      expect(pngIcon.type).toBe("image/png");
    });
    applyControlUiPresentation({ environment });
    applyControlUiFaviconStatus("idle");
    expect(svgIcon.href).toBe(environmentHref);
    expect(pngIcon.href).toBe(environmentHref);
    expect(svgIcon.hasAttribute("data-openclaw-original-favicon")).toBe(true);
    applyControlUiPresentation({ environment: null });
    expectOriginals();
  });

  it.each(["resolve", "reject"])(
    "keeps the current attention icon when an earlier composition later %ss",
    async (settlement) => {
      const earlier = createDeferred<Response>();
      const current = createDeferred<Response>();
      vi.spyOn(globalThis, "fetch")
        .mockReturnValueOnce(earlier.promise)
        .mockReturnValueOnce(current.promise);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      applyControlUiFaviconStatus("attention");
      applyControlUiFaviconStatus("idle");
      applyControlUiFaviconStatus("attention");
      current.resolve(new Response(faviconSvg.replace("<svg", '<svg data-generation="current"')));
      await vi.waitFor(() => {
        expect(svgDocument().querySelector('[data-generation="current"]')).not.toBeNull();
      });
      const currentHref = svgIcon.href;
      if (settlement === "resolve") {
        earlier.resolve(new Response(faviconSvg));
      } else {
        earlier.reject(new Error("Earlier asset request failed"));
      }
      await earlier.promise.catch(() => undefined);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(svgIcon.href).toBe(currentHref);
    },
  );

  it("does not publish delayed SVG composition after returning to idle", async () => {
    const response = createDeferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    applyControlUiFaviconStatus("attention");
    expect(fetchSpy).toHaveBeenCalled();
    applyControlUiFaviconStatus("idle");
    response.resolve(new Response(faviconSvg, { headers: { "Content-Type": "image/svg+xml" } }));
    await response.promise;
    // The browser completes the response and its composition microtasks before painting.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expectOriginals();
  });
});
