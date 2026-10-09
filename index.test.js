// The plugin's own tests: the geometry, the cleaning and the PDF are all written here, with no
// library and nothing from the network, so each one is checked on its own.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEXTS,
  a4Box,
  base64Of,
  clamped,
  cleaned,
  homography,
  outName,
  pdfOf,
  project,
  quadSize,
  startingQuad,
  t,
  warp,
} from "./dist/index.js";
import source from "./dist/index.js?raw";
import manifest from "./module.json";

// The app's languages (plugin-sdk, module.schema.json): English is the top level.
const languages = ["es", "pt", "fr", "de", "it", "ro", "ru", "uk", "pl", "tr", "ar", "hi", "bn", "id", "vi", "th", "ja", "ko", "zh-CN", "zh-TW"];

// The schema counts characters, not UTF-16 units.
const length = (text) => [...text].length;

describe("manifest", () => {
  it("names and sums itself up in every language of the app", () => {
    expect(Object.keys(manifest.locales ?? {})).toEqual(languages);
    for (const code of languages) {
      const { name, summary, ...rest } = manifest.locales[code];
      expect(rest, code).toEqual({});
      expect(name?.trim(), code).toBeTruthy();
      expect(length(name), code).toBeLessThanOrEqual(40);
      expect(summary?.trim(), code).toBeTruthy();
      expect(length(summary), code).toBeLessThanOrEqual(200);
    }
  });

  // What it makes goes to the chat through ft.send, which the core refuses without the send
  // permission: the manifest has to ask for it, or the main action does nothing.
  it("asks to write in the chat, since it puts its result there", () => {
    expect(source).toMatch(/\bft\??\.send\(/);
    expect(manifest.permissions.send).toBe("propose");
  });

  it("offers itself for pictures shared with 'open with'", () => {
    expect(manifest.opens).toEqual(["image/*"]);
    expect(manifest.components).toEqual(["ft-scanner"]);
  });

  it("asks for nothing it does not use", () => {
    expect(Object.keys(manifest.permissions)).toEqual(["send"]);
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });
});

describe("texts", () => {
  it("say everything in every language of the app", () => {
    const keys = Object.keys(TEXTS.en).sort();
    expect(Object.keys(TEXTS).sort()).toEqual(["en", ...languages].sort());
    for (const [code, table] of Object.entries(TEXTS)) {
      expect(Object.keys(table).sort(), code).toEqual(keys);
      for (const key of keys) expect(table[key].trim(), `${code}.${key}`).toBeTruthy();
      expect(table.pages, code).toContain("{n}");
    }
  });

  it("name the camera in every language of the app", () => {
    expect(t("en", "camera")).toBe("Take a photo");
    expect(t("es", "camera")).toBe("Hacer una foto");
  });

  it("fall back to English for a language the app does not have, and fill the count in", () => {
    expect(t("es", "scan")).toBe("Enderezar");
    expect(t("pt-BR", "scan")).toBe(TEXTS.pt.scan);
    expect(t("xx", "scan")).toBe("Straighten");
    expect(t("de", "pages", { n: 3 })).toBe("3 Seiten");
    expect(t("en", "nothing-of-the-kind")).toBe("nothing-of-the-kind");
  });
});

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("geometry", () => {
  it("finds the homography that takes four corners to four others", () => {
    const skewed = [
      { x: 2, y: 1 },
      { x: 13, y: 3 },
      { x: 11, y: 14 },
      { x: 1, y: 12 },
    ];
    const h = homography(square, skewed);
    expect(h).toHaveLength(9);
    expect(h[8]).toBe(1);
    square.forEach((corner, index) => {
      const to = project(h, corner.x, corner.y);
      expect(to.x).toBeCloseTo(skewed[index].x, 6);
      expect(to.y).toBeCloseTo(skewed[index].y, 6);
    });
    // The middle of the square lands inside the skewed quad, not on its edge.
    const centre = project(h, 5, 5);
    expect(centre.x).toBeGreaterThan(2);
    expect(centre.x).toBeLessThan(13);
  });

  it("is a plain move when the corners only slide", () => {
    const moved = square.map(({ x, y }) => ({ x: x + 3, y: y - 2 }));
    const h = homography(square, moved);
    expect(project(h, 7, 7)).toEqual({ x: 10, y: 5 });
  });

  it("has no answer when the corners fall on a line", () => {
    const flat = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    expect(homography(square, flat)).toBe(null);
  });

  it("sizes the page by the mean of its opposite sides, never past the limit", () => {
    expect(quadSize(square)).toEqual({ width: 10, height: 10 });
    const paper = [
      { x: 100, y: 50 },
      { x: 500, y: 60 },
      { x: 480, y: 650 },
      { x: 120, y: 630 },
    ];
    const size = quadSize(paper);
    expect(size.width).toBeGreaterThan(350);
    expect(size.width).toBeLessThan(410);
    expect(size.height).toBeGreaterThan(570);
    expect(size.height).toBeLessThan(600);
    const huge = quadSize(square.map(({ x, y }) => ({ x: x * 400, y: y * 200 })), 1600);
    expect(huge).toEqual({ width: 1600, height: 800 });
    expect(quadSize(square.map(({ x, y }) => ({ x: x / 10, y: y / 10 })))).toEqual({ width: 8, height: 8 });
  });

  it("starts the corners a little inside the picture, and keeps a dragged one inside it", () => {
    const quad = startingQuad({ width: 100, height: 200 });
    expect(quad).toEqual([
      { x: 6, y: 12 },
      { x: 94, y: 12 },
      { x: 94, y: 188 },
      { x: 6, y: 188 },
    ]);
    expect(clamped({ x: -5, y: 250 }, { width: 100, height: 200 })).toEqual({ x: 0, y: 200 });
    expect(clamped({ x: 50, y: 50 }, { width: 100, height: 200 })).toEqual({ x: 50, y: 50 });
  });
});

/** A picture of `width` × `height`, every pixel painted by `paint(x, y)` → [r, g, b]. */
function picture(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

const pixel = ({ width, data }, x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

describe("straightening", () => {
  it("copies the picture as it is when the corners are its own", () => {
    const stripes = picture(16, 8, (x) => (x < 8 ? [200, 30, 30] : [30, 30, 200]));
    const page = warp(
      stripes,
      [
        { x: 0, y: 0 },
        { x: 16, y: 0 },
        { x: 16, y: 8 },
        { x: 0, y: 8 },
      ],
      { width: 16, height: 8 },
    );
    expect(page.width).toBe(16);
    expect(page.height).toBe(8);
    expect(pixel(page, 2, 3)).toEqual([200, 30, 30, 255]);
    expect(pixel(page, 13, 3)).toEqual([30, 30, 200, 255]);
  });

  it("brings a tilted quad back to a straight page", () => {
    // A dark "paper" drawn as a parallelogram on a white picture.
    const inside = (x, y) => {
      const shift = y / 2;
      return x >= 10 + shift && x < 30 + shift && y >= 10 && y < 50;
    };
    const photo = picture(64, 64, (x, y) => (inside(x + 0.5, y + 0.5) ? [40, 40, 40] : [255, 255, 255]));
    const quad = [
      { x: 10 + 5, y: 10 },
      { x: 30 + 5, y: 10 },
      { x: 30 + 25, y: 50 },
      { x: 10 + 25, y: 50 },
    ];
    const page = warp(photo, quad, { width: 20, height: 40 });
    // Deep inside the page everything is the paper; a sample of pixels, away from the edges.
    for (const [x, y] of [[5, 5], [10, 20], [15, 35], [3, 37]]) {
      expect(pixel(page, x, y)[0], `${x},${y}`).toBeLessThan(80);
    }
  });

  it("paints white where the corners point outside the picture", () => {
    const dark = picture(8, 8, () => [0, 0, 0]);
    const page = warp(
      dark,
      [
        { x: -10, y: -10 },
        { x: 18, y: -10 },
        { x: 18, y: 18 },
        { x: -10, y: 18 },
      ],
      { width: 10, height: 10 },
    );
    expect(pixel(page, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(page, 9, 9)).toEqual([255, 255, 255, 255]);
    expect(pixel(page, 5, 5)).toEqual([0, 0, 0, 255]);
  });

  it("gives a white page when the corners make no quad", () => {
    const dark = picture(8, 8, () => [0, 0, 0]);
    const page = warp(dark, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], { width: 4, height: 4 });
    expect(Array.from(page.data).every((value) => value === 255)).toBe(true);
  });
});

describe("cleaning", () => {
  it("turns grey paper white and the ink black, in grey", () => {
    const page = picture(20, 20, (x, y) => (x >= 8 && x < 12 && y >= 8 && y < 12 ? [60, 50, 55] : [190, 185, 180]));
    const made = cleaned(page);
    expect(made.width).toBe(20);
    expect(pixel(made, 1, 1)).toEqual([255, 255, 255, 255]);
    const ink = pixel(made, 9, 9);
    expect(ink[0]).toBeLessThan(40);
    expect(ink[0]).toBe(ink[1]);
    expect(ink[1]).toBe(ink[2]);
    expect(ink[3]).toBe(255);
  });

  it("follows the brightness of the page, so a dim photo still comes out as paper", () => {
    const dim = picture(10, 10, () => [120, 120, 120]);
    expect(pixel(cleaned(dim), 4, 4)).toEqual([255, 255, 255, 255]);
    const bright = picture(10, 10, () => [250, 250, 250]);
    expect(pixel(cleaned(bright), 4, 4)).toEqual([255, 255, 255, 255]);
    // A shadow across half the page is still paper, as long as it is brighter than the ink.
    const shaded = picture(20, 20, (x, y) => (x === 10 && y === 10 ? [20, 20, 20] : y < 10 ? [200, 200, 200] : [165, 165, 165]));
    expect(pixel(cleaned(shaded), 4, 15)).toEqual([255, 255, 255, 255]);
    expect(pixel(cleaned(shaded), 10, 10)[0]).toBe(0);
    // A black photo is not turned into a white page.
    const night = picture(10, 10, () => [5, 5, 5]);
    expect(pixel(cleaned(night), 4, 4)[0]).toBe(0);
  });
});

describe("names", () => {
  it("keeps the name of the photo and changes its extension, never a path", () => {
    expect(outName("letter.HEIC", "jpg")).toBe("letter.jpg");
    expect(outName("/sdcard/DCIM/IMG_001.jpg", "jpg")).toBe("IMG_001.jpg");
    expect(outName("C:\\photos\\a.b.png", "jpg")).toBe("a.b.jpg");
    expect(outName("", "jpg")).toBe("scan.jpg");
    expect(outName(".jpg", "jpg")).toBe("scan.jpg");
  });
});

const text = (bytes) => new TextDecoder("latin1").decode(bytes);
/** A tiny thing that stands in for a JPEG: the writer only carries its bytes. */
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

describe("PDF", () => {
  it("fits a page in A4, centred, with a margin", () => {
    const tall = a4Box({ width: 1000, height: 2000 });
    expect(tall.page).toEqual({ width: 595, height: 842 });
    expect(tall.height).toBeCloseTo(842 - 48, 0);
    expect(tall.x).toBeGreaterThan(24);
    expect(tall.y).toBeCloseTo(24, 0);
  });

  it("writes one PDF page per scanned page", () => {
    const made = text(pdfOf([{ jpeg, width: 100, height: 50 }, { jpeg, width: 50, height: 100 }, { jpeg, width: 80, height: 80 }]));
    expect(made.startsWith("%PDF-1.4")).toBe(true);
    expect(made).toContain("/Count 3");
    expect(made.match(/\/Type \/Page[^s]/g)).toHaveLength(3);
    expect(made).toContain("/Filter /DCTDecode");
    expect(made.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  // A reader finds the objects through the table: a wrong offset is an unopenable file.
  it("points the table at where each object really is", () => {
    const made = text(pdfOf([{ jpeg, width: 100, height: 50 }, { jpeg, width: 50, height: 100 }]));
    const start = Number(made.slice(made.lastIndexOf("startxref")).split("\n")[1]);
    expect(made.slice(start, start + 4)).toBe("xref");
    const lines = made.slice(start).split("\n");
    const objects = Number(lines[1].split(" ")[1]);
    const table = lines.slice(2);
    for (let object = 1; object < objects; object += 1) {
      const offset = Number(table[object].slice(0, 10));
      expect(made.slice(offset, offset + `${object} 0 obj`.length)).toBe(`${object} 0 obj`);
    }
  });

  it("is nothing at all without pages, and carries bytes as base64", () => {
    expect(pdfOf([])).toBe(null);
    expect(base64Of(new Uint8Array([65, 66, 67]))).toBe("QUJD");
    const long = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(atob(base64Of(long)).length).toBe(long.length);
  });
});

describe("component", () => {
  // The tool draws in the page (Ionic's styles do not cross a shadow root), and Ionic moves a
  // button's first aria attributes to the native button inside it once it has drawn.
  const aria = (element, name) => element.getAttribute(name) ?? element.shadowRoot?.querySelector("button")?.getAttribute(name);

  it("is a custom element the frame can show", () => {
    expect(customElements.get("ft-scanner")).toBeTruthy();
  });

  it("speaks the language the app opens it with, and asks for a photo when it has none", async () => {
    const calls = [];
    let open;
    globalThis.ft = {
      onOpen: (handler) => {
        open = handler;
      },
      pickFile: async (accept) => {
        calls.push(accept);
        return null;
      },
      send: () => {},
    };
    const element = document.createElement("ft-scanner");
    document.body.append(element);
    expect(aria(element.querySelector('[data-act="pick"]'), "aria-label")).toBe("Pick a photo");
    open({ lang: "es", dark: false });
    await Promise.resolve();
    expect(calls).toEqual(["image/*"]);
    expect(aria(element.querySelector('[data-act="scan"]'), "aria-label")).toBe("Enderezar");
    expect(element.querySelector('[data-act="scan"]').disabled).toBe(true);
    expect(element.querySelector('[data-act="pdf"]').disabled).toBe(true);
    expect(aria(element.querySelector('[data-act="clean"]'), "aria-pressed")).toBe("true");
    element.remove();
    delete globalThis.ft;
  });

  // 2026-10-06: from app 1.4.1 a plugin may ask for a photo straight from the phone's camera app.
  // The button is there only when the app has it; an older app keeps the gallery alone.
  const opened = (ft) => {
    let open;
    globalThis.ft = { onOpen: (handler) => (open = handler), send: () => {}, ...ft };
    const element = document.createElement("ft-scanner");
    document.body.append(element);
    const loaded = [];
    element.load = async (picked) => loaded.push(picked);
    return { element, loaded, open: (opening) => open(opening), $: (selector) => element.querySelector(selector) };
  };
  const done = () => {
    document.querySelector("ft-scanner")?.remove();
    delete globalThis.ft;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("puts a camera button first in the bar, only on an app that can take a photo", () => {
    const camera = opened({ pickFile: async () => null, takePhoto: async () => null });
    const first = camera.$("ion-toolbar ion-button");
    expect(first.dataset.act).toBe("camera");
    expect(aria(first, "aria-label")).toBe("Take a photo");
    expect(first.querySelector('[slot="icon-only"]').getAttribute("style")).toContain("./icon/camera-outline.svg");
    camera.open({ lang: "es" });
    expect(aria(camera.$('ion-toolbar [data-act="camera"]'), "aria-label")).toBe("Hacer una foto");
    done();

    const older = opened({ pickFile: async () => null });
    expect(older.$('[data-act="camera"]')).toBe(null);
    expect(older.$("ion-toolbar ion-button").dataset.act).toBe("pick");
    done();
  });

  it("loads the photo the camera took, as a picked one, and nothing when the user backs out", async () => {
    const photo = { name: "photo.jpg", mime: "image/jpeg", data: "QUJD" };
    const takePhoto = vi.fn(async () => photo);
    const camera = opened({ pickFile: async () => null, takePhoto });
    camera.$('ion-toolbar [data-act="camera"]').click();
    await tick();
    expect(takePhoto).toHaveBeenCalledTimes(1);
    expect(camera.loaded).toEqual([photo]);

    takePhoto.mockResolvedValueOnce(null);
    camera.$('ion-toolbar [data-act="camera"]').click();
    await tick();
    expect(camera.loaded).toEqual([photo]);
    done();
  });

  it("opens on the two choices, camera and gallery, instead of the gallery, when the app has the camera", async () => {
    const photo = { name: "photo.jpg", mime: "image/jpeg", data: "QUJD" };
    const pickFile = vi.fn(async () => null);
    const takePhoto = vi.fn(async () => photo);
    const camera = opened({ pickFile, takePhoto });
    camera.open({ lang: "es" });
    await tick();
    expect(pickFile).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();
    const choices = [...camera.element.querySelectorAll(".choices ion-button")];
    expect(choices.map((button) => button.dataset.act)).toEqual(["camera", "pick"]);
    expect(choices.map((button) => aria(button, "aria-label"))).toEqual(["Hacer una foto", "Elegir una foto"]);

    camera.$('.choices [data-act="pick"]').click();
    await tick();
    expect(pickFile).toHaveBeenCalledWith("image/*");
    camera.$('.choices [data-act="camera"]').click();
    await tick();
    expect(takePhoto).toHaveBeenCalledTimes(1);
    expect(camera.loaded).toEqual([photo]);
    done();
  });

  it("shows no choices on an app without the camera, which opens the gallery as before", async () => {
    const pickFile = vi.fn(async () => null);
    const older = opened({ pickFile });
    older.open({ lang: "en" });
    await tick();
    expect(pickFile).toHaveBeenCalledWith("image/*");
    expect(older.$(".choices")).toBe(null);
    done();
  });

  it("says so when a picture cannot be read", async () => {
    let open;
    globalThis.ft = { onOpen: (handler) => (open = handler), pickFile: async () => null, send: () => {} };
    const element = document.createElement("ft-scanner");
    document.body.append(element);
    open({ lang: "fr", file: { name: "x.jpg", mime: "image/jpeg", data: "bm90LWEtcGljdHVyZQ==" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.querySelector(".note:not([hidden])")?.textContent).toBe("Cette image ne peut pas être lue");
    element.remove();
    delete globalThis.ft;
  });
});

describe("with the Ionic the app lends", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const aria = (button, name) => button.getAttribute(name) ?? button.shadowRoot?.querySelector("button")?.getAttribute(name);
  const mount = async (ft = {}) => {
    globalThis.ft = { onOpen() {}, pickFile: async () => null, send: () => {}, ...ft };
    document.body.innerHTML = "";
    const element = document.createElement("ft-scanner");
    document.body.append(element);
    await tick();
    return element;
  };
  /** A page already straightened, as `keep` leaves it. */
  const kept = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    return { canvas, name: "a.jpg" };
  };

  afterEach(() => {
    delete globalThis.Ionicons;
    delete globalThis.ft;
    document.body.innerHTML = "";
  });

  // Only an app that lends Ionic can show it (app 1.6.0): an older one keeps the version it has.
  it("asks for an app that lends Ionic", () => {
    expect(manifest.minCoreVersion).toBe("1.6.0");
  });

  it("draws in the page, not in a shadow root, with the bar in ion-header and the rest in ion-content", async () => {
    const element = await mount({ takePhoto: async () => null });
    expect(element.shadowRoot).toBe(null);
    expect(element.querySelector(":scope > ion-header > ion-toolbar")).toBeTruthy();
    expect(element.querySelector(":scope > ion-content .choices")).toBeTruthy();
    const acts = [...element.querySelectorAll("ion-toolbar ion-button")].map((button) => button.dataset.act);
    expect(acts).toEqual(["camera", "pick", "scan", "clean", "keep", "image", "pdf"]);
    for (const button of element.querySelectorAll("ion-toolbar ion-button")) expect(aria(button, "aria-label"), button.dataset.act).toBeTruthy();
    // The corner handles are drag handles over the picture, not actions: the only plain buttons.
    expect(element.querySelector("button:not(.handle)")).toBe(null);
  });

  // Ionic draws a button once; drawing the bar again on every change would flash it.
  it("draws the bar once and keeps it while the page below changes", async () => {
    const element = await mount();
    const bar = element.querySelector("ion-toolbar");
    const pdf = element.querySelector('ion-toolbar [data-act="pdf"]');
    expect(pdf.disabled).toBe(true);
    element.pages.push(kept());
    element.paint();
    expect(element.querySelector("ion-toolbar")).toBe(bar);
    expect(element.querySelector('ion-toolbar [data-act="pdf"]')).toBe(pdf);
    expect(pdf.disabled).toBe(false);
    expect(element.querySelectorAll(":scope > ion-content ol li")).toHaveLength(1);
  });

  it("shows cleaning as a pressed button, and takes a page out with the Ionic button of its row", async () => {
    const element = await mount();
    const clean = element.querySelector('ion-toolbar [data-act="clean"]');
    expect(clean.fill).toBe("solid");
    clean.click();
    await tick();
    expect(aria(clean, "aria-pressed")).toBe("false");
    expect(clean.fill).toBe(undefined);

    element.pages.push(kept(), kept());
    element.paint();
    const drop = element.querySelector('ol ion-button[data-act="drop"]');
    expect(aria(drop, "aria-label")).toBeTruthy();
    drop.click();
    expect(element.pages).toHaveLength(1);
  });

  // The icons are the app's: Ionic's own when the app lent them by name, else the ones it serves.
  it("draws an Ionicon the app lent by name with ion-icon, and the one it serves otherwise", async () => {
    let element = await mount();
    expect(element.querySelector('[data-act="pick"] ion-icon')).toBe(null);
    expect(element.querySelector('[data-act="pick"] [slot="icon-only"]').getAttribute("style")).toContain("./icon/image-outline.svg");

    globalThis.Ionicons = { map: new Map([["image-outline", "data:image/svg+xml;utf8,<svg></svg>"]]) };
    element = await mount();
    expect(element.querySelector('[data-act="pick"] ion-icon[slot="icon-only"]').getAttribute("name")).toBe("image-outline");
  });
});

describe("the package", () => {
  const dist = join(import.meta.dirname, "dist");
  const files = readdirSync(dist);

  // Ionic is the app's, lent to the frame: a copy in the package would be a second one, and heavy.
  it("carries no Ionic of its own", () => {
    for (const file of files) {
      const code = readFileSync(join(dist, file), "utf8");
      expect(code, file).not.toMatch(/@ionic\/core|ionicframework|stencil|defineCustomElement|__registerHost/i);
      expect(code, file).not.toMatch(/^\s*import\s.*from\s+["'](?!\.\/)/m);
    }
  });

  // The app carries it as a seed on iOS: 128 KiB at most (plugin-sdk).
  it("is small enough to be a seed", () => {
    const bytes = files.reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
  });
});

describe("the image of the Apps grid", () => {
  // icon.svg beside module.json and dist/, signed with the rest: the app draws it on the tile; the
  // Ionicon in module.json stays as the fallback (2026-10-08).
  const image = join(import.meta.dirname, "icon.svg");

  it("is a square 64 × 64 SVG of at most 4 KB at the root of the package, and not inside dist/", () => {
    expect(existsSync(image), "icon.svg").toBe(true);
    expect(statSync(image).size).toBeLessThanOrEqual(4096);
    const svg = readFileSync(image, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(existsSync(join(import.meta.dirname, "dist", "icon.svg"))).toBe(false);
  });
});
