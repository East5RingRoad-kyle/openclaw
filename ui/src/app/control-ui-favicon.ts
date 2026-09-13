type FaviconSource = { svg: Element } | { image: HTMLImageElement };

type FaviconComposition = {
  href: string;
  type: string | null;
  color: string;
  ring: string;
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

async function loadSource(href: string, type: string | null): Promise<FaviconSource> {
  if (type === "image/svg+xml" || /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(href)) {
    const response = await fetch(href);
    if (!response.ok) {
      throw new Error(`Favicon loading failed (${response.status})`);
    }
    const parsed = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
    const svg = parsed.documentElement;
    if (
      parsed.querySelector("parsererror") ||
      svg.localName !== "svg" ||
      svg.namespaceURI !== SVG_NAMESPACE
    ) {
      throw new Error("Invalid SVG favicon");
    }
    return { svg };
  }
  const image = new Image();
  image.src = href;
  await image.decode();
  return { image };
}

export function createControlUiFaviconComposer() {
  const sources = new Map<string, Promise<FaviconSource>>();
  return async ({ href, type, color, ring }: FaviconComposition) => {
    const key = JSON.stringify([href, type]);
    let pending = sources.get(key);
    if (!pending) {
      pending = loadSource(href, type);
      sources.set(key, pending);
      void pending.catch(() => sources.delete(key));
    }
    const source = await pending;
    if ("svg" in source) {
      const svg = document.createElementNS(SVG_NAMESPACE, "svg");
      svg.setAttribute("viewBox", "0 0 32 32");
      svg.setAttribute("width", "32");
      svg.setAttribute("height", "32");
      // Keep SMIL in the favicon document; SVG images cannot load external images.
      const artwork = document.importNode(source.svg, true);
      artwork.setAttribute("x", "0");
      artwork.setAttribute("y", "0");
      artwork.setAttribute("width", "32");
      artwork.setAttribute("height", "32");
      svg.append(artwork);
      const dot = document.createElementNS(SVG_NAMESPACE, "circle");
      dot.setAttribute("cx", "25.5");
      dot.setAttribute("cy", "25.5");
      dot.setAttribute("r", "5");
      dot.setAttribute("fill", color);
      dot.setAttribute("stroke", ring);
      dot.setAttribute("stroke-width", "2");
      svg.append(dot);
      return {
        href: `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`,
        type: "image/svg+xml",
      };
    }
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Favicon canvas unavailable");
    }
    context.drawImage(source.image, 0, 0, 32, 32);
    context.beginPath();
    context.arc(25.5, 25.5, 5, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = ring;
    context.lineWidth = 2;
    context.stroke();
    return { href: canvas.toDataURL("image/png"), type: "image/png" };
  };
}
