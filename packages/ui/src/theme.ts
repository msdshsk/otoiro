/**
 * Per-track colour themes. A palette comes either from the cover art or, for the many BGM
 * files that have none, from how the track sounds.
 */
export interface Palette {
  /** Main accent: progress, buttons. */
  accent: string;
  /** Second hue for gradients. */
  accent2: string;
  /** Very dark tint for backgrounds. */
  base: string;
  /** Mid-dark tint for glows behind content. */
  glow: string;
}

const HUE_BINS = 24;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const hsl = (h: number, s: number, l: number) =>
  `hsl(${((h % 360) + 360) % 360} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60
    : max === g ? ((b - r) / d + 2) * 60
    : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function build(h1: number, h2: number, saturation: number): Palette {
  const s = clamp(saturation, 0.12, 0.9);
  return {
    accent: hsl(h1, s, 0.64),
    accent2: hsl(h2, s, 0.6),
    base: hsl(h1, Math.min(s, 0.45), 0.07),
    glow: hsl(h1, Math.min(s, 0.7), 0.28),
  };
}

/** Picks the dominant vivid hue (and a contrasting second one) from an image. */
export async function paletteFromImage(image: Blob): Promise<Palette> {
  const size = 48;
  const bitmap = await createImageBitmap(image, { resizeWidth: size, resizeHeight: size, resizeQuality: "low" });
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, size, size);

  // Weighted hue histogram. Vivid, mid-lightness pixels count most; greys barely count.
  const weight = new Float64Array(HUE_BINS);
  const sumX = new Float64Array(HUE_BINS);
  const sumY = new Float64Array(HUE_BINS);
  const sumS = new Float64Array(HUE_BINS);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const w = s * s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.8);
    if (w <= 0) continue;
    const bin = Math.floor((h / 360) * HUE_BINS) % HUE_BINS;
    const rad = (h * Math.PI) / 180;
    weight[bin] += w;
    sumX[bin] += Math.cos(rad) * w;
    sumY[bin] += Math.sin(rad) * w;
    sumS[bin] += s * w;
    total += w;
  }

  const hueOf = (bin: number) => (Math.atan2(sumY[bin], sumX[bin]) * 180) / Math.PI;
  const order = [...weight.keys()].sort((a, b) => weight[b] - weight[a]);
  const first = order[0];

  // Practically monochrome cover: keep it muted rather than inventing a colour.
  if (total < 1 || weight[first] === 0) return build(230, 260, 0.12);

  const h1 = hueOf(first);
  const s1 = sumS[first] / weight[first];
  const second = order.find((bin) => {
    if (weight[bin] < weight[first] * 0.15) return false;
    const d = Math.abs(((hueOf(bin) - h1 + 540) % 360) - 180);
    return d >= 40;
  });
  const h2 = second != null ? hueOf(second) : h1 + 38;
  return build(h1, h2, s1 * 1.1);
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

/**
 * Colour from sound: dark/bassy tracks lean indigo, bright ones lean warm. `seed` (e.g. the
 * path) adds a small stable offset so similar tracks still look distinct.
 */
export function paletteFromSound(brightness: number, loudness: number, seed: string): Palette {
  const t = clamp((brightness - 0.5) / 0.3, 0, 1);
  const h1 = 250 + t * 140 + (hash(seed) - 0.5) * 36;
  return build(h1, h1 + 42, 0.5 + clamp(loudness, 0, 1) * 0.6);
}

export const DEFAULT_PALETTE: Palette = build(255, 190, 0.85);

/** Sets `--oto-accent`, `--oto-accent-2`, `--oto-base`, `--oto-glow` on `el`. */
export function applyPalette(el: HTMLElement, palette: Palette) {
  el.style.setProperty("--oto-accent", palette.accent);
  el.style.setProperty("--oto-accent-2", palette.accent2);
  el.style.setProperty("--oto-base", palette.base);
  el.style.setProperty("--oto-glow", palette.glow);
}

/**
 * Registers the palette variables as typed colours so changing them animates (call once).
 * Pair with `transition: --oto-accent 600ms, ...` on the element you apply palettes to.
 */
export function registerPaletteProperties() {
  const props: [string, Palette[keyof Palette]][] = [
    ["--oto-accent", DEFAULT_PALETTE.accent],
    ["--oto-accent-2", DEFAULT_PALETTE.accent2],
    ["--oto-base", DEFAULT_PALETTE.base],
    ["--oto-glow", DEFAULT_PALETTE.glow],
  ];
  for (const [name, initialValue] of props) {
    try {
      CSS.registerProperty({ name, syntax: "<color>", inherits: true, initialValue });
    } catch {
      // Already registered.
    }
  }
}
