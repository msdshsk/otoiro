import { PlayerElement } from "./base";
import { formatTime } from "./player";

/** Drag travel for one notch. Small enough to place a single frame by hand. */
const PIXELS_PER_NOTCH = 10;
/** Wheel travel (pixel-mode deltas, e.g. touchpads) for one notch. */
const WHEEL_PIXELS_PER_NOTCH = 60;
/** After this long without turning, the next turn starts from the player's position again. */
const RESYNC_AFTER_MS = 400;
/** Beat length used when the tempo is unknown. */
const FALLBACK_BEAT_SECONDS = 0.5;

/** Base unit a notch moves by. Shift goes one step coarser, Ctrl always moves by a frame. */
export type JogUnit = "beat" | "bar" | "section" | "second" | "frame";
const UNITS: JogUnit[] = ["beat", "bar", "section", "second", "frame"];

/** What one notch currently means, after modifiers. */
type Resolved = "beat" | "bar" | "bars4" | "section" | "second" | "seconds10" | "frame" | "frames10";

export type JogUnitLabels = Record<Resolved, string> & {
  /** Shown instead of beat/bar labels when the tempo is unknown; `{s}` is the step in seconds. */
  seconds: string;
};

const DEFAULT_LABELS: JogUnitLabels = {
  beat: "1 beat",
  bar: "1 bar",
  bars4: "4 bars",
  section: "section",
  second: "1 s",
  seconds10: "10 s",
  frame: "1 frame",
  frames10: "10 frames",
  seconds: "{s} s",
};

/** Dial rotation per notch, so coarser steps also look bigger. */
const DEGREES: Record<Resolved, number> = {
  frame: 6,
  frames10: 24,
  beat: 12,
  second: 12,
  bar: 30,
  seconds10: 36,
  bars4: 60,
  section: 45,
};

const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>`;

const template = document.createElement("template");
template.innerHTML = `
<style>
  :host {
    --_accent: var(--oto-accent, #22d3ee);
    --_size: var(--oto-jog-size, 120px);
    display: inline-block;
    position: relative;
    width: var(--_size);
    height: var(--_size);
    cursor: ns-resize;
    touch-action: none;
    user-select: none;
    outline: none;
    border-radius: 50%;
  }
  :host(:focus-visible) { box-shadow: 0 0 0 2px color-mix(in srgb, var(--_accent) 70%, transparent); }
  svg.face { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .rotor { transform-origin: 56px 56px; transition: transform 70ms ease-out; }
  .glow {
    fill: none;
    stroke: var(--_accent);
    stroke-width: 4;
    stroke-dasharray: 1 2;
    opacity: 0;
    filter: drop-shadow(0 0 4px var(--_accent));
  }
  .dot { fill: var(--_accent); filter: drop-shadow(0 0 4px var(--_accent)); }
  :host([turning]) .dot { filter: drop-shadow(0 0 7px var(--_accent)); }
  .center {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 46%;
    height: 46%;
    translate: -50% -50%;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--_accent);
    cursor: pointer;
  }
  .center:hover { background: rgb(255 255 255 / 0.04); }
  .center svg { width: 15px; height: 15px; fill: currentColor; }
  .label {
    font: 9px/1.2 Consolas, ui-monospace, monospace;
    color: rgb(230 236 240 / 0.6);
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  :host([turning]) .label { color: rgb(240 246 250 / 0.95); }
  .unit {
    position: absolute;
    left: 50%;
    bottom: -7px;
    translate: -50% 0;
    padding: 2px 7px 2px 8px;
    border: 1px solid #56616A;
    border-radius: 999px;
    background: #0d1012;
    color: var(--_accent);
    font: 600 9px/1.3 system-ui, "Segoe UI", "Yu Gothic UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.5);
    transition: border-color 120ms, background 120ms;
  }
  .unit::after { content: " ▾"; opacity: 0.6; font-size: 8px; }
  .unit:hover { border-color: var(--_accent); }
  :host([modified]) .unit { background: color-mix(in srgb, var(--_accent) 25%, #0d1012); }
</style>
<svg class="face" viewBox="0 0 112 112" aria-hidden="true">
  <g class="rotor">
    <circle cx="56" cy="56" r="55.5" fill="#080A0C" stroke="#63717B" stroke-width="1"/>
    <circle cx="56" cy="56" r="50.5" fill="#171B1F" stroke="#20262B" stroke-width="3"/>
    <circle cx="56" cy="56" r="43.5" fill="#0D1012" stroke="#56616A" stroke-width="1"/>
    <circle cx="56" cy="56" r="36" fill="none" stroke="#46525B" stroke-width="4" stroke-dasharray="1 2"/>
    <circle class="glow" cx="56" cy="56" r="36"/>
    <circle cx="56" cy="56" r="21.5" fill="#070809" stroke="#77848D" stroke-width="1"/>
    <circle class="dot" cx="56" cy="19" r="5"/>
    <rect x="54.5" y="3" width="3" height="13" rx="1" fill="rgb(255 255 255 / 0.9)"/>
  </g>
</svg>
<button class="center" part="center" aria-label="Play">
  <span class="icon"></span>
  <span class="label" part="label">SCRUB</span>
</button>
<button class="unit" part="unit"></button>
`;

export interface JogTurnDetail {
  notches: number;
  /** Seconds moved by this turn. */
  delta: number;
  /** Scrub target after this turn. */
  position: number;
}

/**
 * `<oto-jog>`: a jog wheel that scrubs the player audibly.
 *
 * - Drag vertically (up = forward, 10 px per notch, remainders carried) or use the wheel
 *   (down = forward, like scrolling down a page).
 * - One notch moves by `unit`: a beat (default; needs `bpm`, otherwise 0.5 s), a bar
 *   (`beats-per-bar`, default 4), a second, or a frame at `fps` (default 30).
 *   Shift goes one step coarser (beat→bar, bar→4 bars, 1 s→10 s, 1→10 frames); Ctrl moves
 *   by a single frame for fine placement.
 * - `section` jumps between `sections` boundaries (and keeps playing if it was).
 * - The chip at the bottom cycles the unit and shows what a notch means right now.
 * - The centre button plays/pauses. Arrow keys turn it when focused.
 *
 * Fires `oto-jog` (`JogTurnDetail`) on every turn and `oto-jog-unit` (`{ unit }`) when the
 * unit changes. Styling: `--oto-accent`, `--oto-jog-size`, `::part(center|label|unit)`.
 */
export class OtoJog extends PlayerElement {
  #rotor: SVGGElement;
  #glow: SVGCircleElement;
  #icon: HTMLElement;
  #label: HTMLElement;
  #center: HTMLButtonElement;
  #unitChip: HTMLButtonElement;
  #labels: JogUnitLabels = DEFAULT_LABELS;
  #modifiers = { shift: false, ctrl: false };
  #shownUnit = "";
  #sections: number[] = [];

  #angle = 0;
  #pointerId: number | null = null;
  #lastY = 0;
  #carry = 0;
  #wheelCarry = 0;
  #cursor: number | null = null;
  #lastTurn = 0;
  #pendingScrub: number | null = null;
  #flushJob = 0;
  #shownPlaying: boolean | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));
    this.#rotor = root.querySelector(".rotor")!;
    this.#glow = root.querySelector(".glow")!;
    this.#icon = root.querySelector(".icon")!;
    this.#label = root.querySelector(".label")!;
    this.#center = root.querySelector(".center")!;
    this.#unitChip = root.querySelector(".unit")!;
    this.#unitChip.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.#unitChip.addEventListener("click", () => this.cycleUnit());

    this.tabIndex = 0;
    this.setAttribute("role", "slider");
    this.setAttribute("aria-label", "Jog");

    this.#center.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.#center.addEventListener("click", () => void this.player?.toggle());
    this.addEventListener("pointerdown", this.#onPointerDown);
    this.addEventListener("pointermove", this.#onPointerMove);
    this.addEventListener("pointerup", this.#endTurn);
    this.addEventListener("pointercancel", this.#endTurn);
    this.addEventListener("lostpointercapture", this.#endTurn);
    this.addEventListener("wheel", this.#onWheel, { passive: false });
    this.addEventListener("keydown", this.#onKeyDown);
  }

  /** Frames per second that one notch represents. */
  get fps(): number {
    const v = Number(this.getAttribute("fps"));
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  set fps(value: number) {
    this.setAttribute("fps", String(value));
  }

  /** Tempo for beat/bar steps; null when unknown (beats fall back to 0.5 s). */
  get bpm(): number | null {
    const v = Number(this.getAttribute("bpm"));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  set bpm(value: number | null) {
    if (value != null && value > 0) this.setAttribute("bpm", String(value));
    else this.removeAttribute("bpm");
  }

  get beatsPerBar(): number {
    const v = Number(this.getAttribute("beats-per-bar"));
    return Number.isInteger(v) && v > 0 ? v : 4;
  }

  set beatsPerBar(value: number) {
    this.setAttribute("beats-per-bar", String(value));
  }

  get unit(): JogUnit {
    const v = this.getAttribute("unit") as JogUnit | null;
    return v && UNITS.includes(v) ? v : "beat";
  }

  set unit(value: JogUnit) {
    this.setAttribute("unit", value);
  }

  /** Overrides the chip texts (e.g. for localisation). */
  set unitLabels(labels: Partial<JogUnitLabels>) {
    this.#labels = { ...DEFAULT_LABELS, ...labels };
  }

  /**
   * Section start times (seconds) for the `section` unit, e.g. from `WaveformData.sections`.
   * Without them the section unit falls back to bars.
   */
  set sections(starts: number[]) {
    this.#sections = [...starts].sort((a, b) => a - b);
  }

  /** Switches to the next base unit (beat → bar → section → second → frame → beat). */
  cycleUnit() {
    this.unit = UNITS[(UNITS.indexOf(this.unit) + 1) % UNITS.length];
    this.dispatchEvent(new CustomEvent("oto-jog-unit", { detail: { unit: this.unit }, bubbles: true }));
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.#trackModifiers);
    window.addEventListener("keyup", this.#trackModifiers);
    window.addEventListener("blur", this.#clearModifiers);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.#trackModifiers);
    window.removeEventListener("keyup", this.#trackModifiers);
    window.removeEventListener("blur", this.#clearModifiers);
  }

  #trackModifiers = (e: KeyboardEvent) => {
    this.#modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey };
  };

  #clearModifiers = () => {
    this.#modifiers = { shift: false, ctrl: false };
  };

  #resolve({ shift = false, ctrl = false }): Resolved {
    if (ctrl) return "frame";
    const unit = this.unit === "section" && this.#sections.length < 2 ? "bar" : this.unit;
    if (!shift) return unit;
    switch (unit) {
      case "beat":
        return "bar";
      case "bar":
        return "bars4";
      case "section":
        return "section";
      case "second":
        return "seconds10";
      case "frame":
        return "frames10";
    }
  }

  #seconds(resolved: Resolved): number {
    const beat = this.bpm ? 60 / this.bpm : FALLBACK_BEAT_SECONDS;
    switch (resolved) {
      case "beat":
        return beat;
      case "bar":
        return beat * this.beatsPerBar;
      case "bars4":
      case "section":
        return beat * this.beatsPerBar * 4;
      case "second":
        return 1;
      case "seconds10":
        return 10;
      case "frame":
        return 1 / this.fps;
      case "frames10":
        return 10 / this.fps;
    }
  }

  #unitText(resolved: Resolved): string {
    const musical = resolved === "beat" || resolved === "bar" || resolved === "bars4";
    if (musical && !this.bpm) {
      const s = Math.round(this.#seconds(resolved) * 100) / 100;
      return this.#labels.seconds.replace("{s}", String(s));
    }
    return this.#labels[resolved];
  }

  protected render(now: number) {
    const playing = this.player?.state === "playing";
    if (playing !== this.#shownPlaying) {
      this.#shownPlaying = playing;
      this.#icon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      this.#center.setAttribute("aria-label", playing ? "Pause" : "Play");
    }
    const turning = now - this.#lastTurn < 700;
    this.toggleAttribute("turning", turning);
    const idle = this.bpm ? `${Math.round(this.bpm)} BPM` : "SCRUB";
    const text = turning && this.#cursor != null ? formatPrecise(this.#cursor) : idle;
    if (this.#label.textContent !== text) this.#label.textContent = text;

    const modified = this.#modifiers.shift || this.#modifiers.ctrl;
    this.toggleAttribute("modified", modified);
    const unitText = this.#unitText(this.#resolve(this.#modifiers));
    if (unitText !== this.#shownUnit) {
      this.#shownUnit = unitText;
      this.#unitChip.textContent = unitText;
      this.#unitChip.title = `1 notch = ${unitText}`;
    }
  }

  /** Turns the dial by whole notches, as a drag/wheel/key would. */
  turn(notches: number, { shift = false, ctrl = false } = {}) {
    if (notches === 0) return;
    const resolved = this.#resolve({ shift, ctrl });
    const step = this.#seconds(resolved);
    this.#angle = (this.#angle + notches * DEGREES[resolved]) % 360;
    this.#rotor.style.transform = `rotate(${this.#angle}deg)`;
    this.#glow.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 450, easing: "ease-out" });

    const now = performance.now();
    const player = this.player;
    if (this.#cursor == null || now - this.#lastTurn > RESYNC_AFTER_MS) {
      this.#cursor = player?.position() ?? 0;
    }
    this.#lastTurn = now;
    const duration = player?.duration ?? Infinity;
    const from = this.#cursor;
    if (resolved === "section") {
      // Jump between boundaries and keep the transport state, so the next section plays.
      let target = from;
      for (let i = 0; i < Math.abs(notches); i++) {
        target =
          notches > 0
            ? (this.#sections.find((t) => t > target + 0.25) ?? duration)
            : (this.#sections.filter((t) => t < target - 0.25).pop() ?? 0);
      }
      this.#cursor = Math.min(Math.max(target, 0), duration);
      if (player?.snapshot.path) void player.seek(this.#cursor);
    } else {
      this.#cursor = Math.min(Math.max(from + notches * step, 0), duration);
      if (player?.snapshot.path) this.#queueScrub(this.#cursor);
    }
    const delta = this.#cursor - from;
    this.dispatchEvent(
      new CustomEvent<JogTurnDetail>("oto-jog", {
        detail: { notches, delta, position: this.#cursor },
        bubbles: true,
      }),
    );
  }

  /** At most one scrub per frame; fast drags just move the target further. */
  #queueScrub(position: number) {
    this.#pendingScrub = position;
    if (this.#flushJob) return;
    this.#flushJob = requestAnimationFrame(() => {
      this.#flushJob = 0;
      const target = this.#pendingScrub;
      this.#pendingScrub = null;
      if (target != null) void this.player?.scrub(target);
    });
  }

  #onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.setPointerCapture(e.pointerId);
    this.#pointerId = e.pointerId;
    this.#lastY = e.clientY;
    this.#carry = 0;
    e.preventDefault();
    this.focus();
  };

  #onPointerMove = (e: PointerEvent) => {
    if (this.#pointerId !== e.pointerId) return;
    // Up is positive. Carry the remainder so slow drags still add up.
    this.#carry += (this.#lastY - e.clientY) / PIXELS_PER_NOTCH;
    this.#lastY = e.clientY;
    const notches = Math.trunc(this.#carry);
    if (notches !== 0) {
      this.#carry -= notches;
      this.turn(notches, { shift: e.shiftKey, ctrl: e.ctrlKey });
    }
  };

  #endTurn = (e: PointerEvent) => {
    if (this.#pointerId !== e.pointerId) return;
    if (this.hasPointerCapture(e.pointerId)) this.releasePointerCapture(e.pointerId);
    this.#pointerId = null;
    this.#carry = 0;
  };

  #onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Scrolling down moves forward, like reading down a page. Shift+wheel arrives as a
    // horizontal scroll in Chromium, so fall back to deltaX.
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    let notches: number;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
      this.#wheelCarry += delta / WHEEL_PIXELS_PER_NOTCH;
      notches = Math.trunc(this.#wheelCarry);
      // A mouse wheel detent (~100 px) is always at least one notch.
      if (notches === 0 && Math.abs(delta) >= WHEEL_PIXELS_PER_NOTCH) notches = Math.sign(delta);
      this.#wheelCarry -= notches;
    } else {
      notches = Math.sign(delta);
    }
    this.turn(notches, { shift: e.shiftKey, ctrl: e.ctrlKey });
  };

  #onKeyDown = (e: KeyboardEvent) => {
    const dir =
      e.key === "ArrowUp" || e.key === "ArrowRight" ? 1
      : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1
      : 0;
    if (dir !== 0) {
      e.preventDefault();
      this.turn(dir, { shift: e.shiftKey, ctrl: e.ctrlKey });
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void this.player?.toggle();
    }
  };
}

/** m:ss.ff-style readout with hundredths, for fine positioning. */
function formatPrecise(seconds: number): string {
  const cs = Math.floor((seconds % 1) * 100);
  return `${formatTime(seconds)}.${String(cs).padStart(2, "0")}`;
}

customElements.define("oto-jog", OtoJog);

declare global {
  interface HTMLElementTagNameMap {
    "oto-jog": OtoJog;
  }
}
