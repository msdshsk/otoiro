import type { WaveformData } from "./media";
import type { Palette } from "./theme";

const SPOKES = 120;

/**
 * Stand-in "cover" for tracks without artwork: the track's loudness contour wrapped into a
 * ring, in the track's own palette. Same file, same picture, so it works as an identity.
 */
export function drawSoundArt(canvas: HTMLCanvasElement, waveform: WaveformData, palette: Palette) {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;

  const bg = ctx.createRadialGradient(cx, cy * 0.8, 0, cx, cy, size * 0.75);
  bg.addColorStop(0, palette.glow);
  bg.addColorStop(1, palette.base);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const { rms } = waveform;
  const n = rms.length;
  const gain = Math.min(1 / Math.max(...rms, 1e-3), 6);
  const inner = size * 0.2;
  const reach = size * 0.24;
  const stroke = ctx.createLinearGradient(0, 0, w, h);
  stroke.addColorStop(0, palette.accent);
  stroke.addColorStop(1, palette.accent2);
  ctx.strokeStyle = stroke;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * inner) / SPOKES * 0.55);

  for (let i = 0; i < SPOKES; i++) {
    const start = Math.floor((i * n) / SPOKES);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / SPOKES));
    let level = 0;
    for (let j = start; j < end && j < n; j++) level = Math.max(level, rms[j]);
    const len = Math.max(size * 0.012, Math.min(1, level * gain) * reach);
    // Start at 12 o'clock and run clockwise, like a clock face over the track's length.
    const a = (i / SPOKES) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
    ctx.stroke();
  }

  ctx.fillStyle = palette.accent;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
