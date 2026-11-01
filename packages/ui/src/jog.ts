import { PlayerElement } from "./base";
import { formatTime } from "./player";

/** Drag travel for one notch. Small enough to place a single frame by hand. */
const PIXELS_PER_NOTCH = 10;
/** Wheel travel (pixel-mode deltas, e.g. touchpads) for one notch. */
const WHEEL_PIXELS_PER_NOTCH = 60;
/** After this long without turning, the next turn starts from the player's position again. */
const RESYNC_AFTER_MS = 400;

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
 * - Drag vertically (up = forward, 10 px per notch, remainders carried) or use the wheel.
 * - One notch is one frame at `fps` (default 30); Shift = 10 frames, Ctrl = 1 second.
 * - The centre button plays/pauses. Arrow keys turn it when focused.
 *
 * Fires `oto-jog` (`JogTurnDetail`) on every turn. Styling: `--oto-accent`, `--oto-jog-size`,
 * `::part(center|label)`.
 */
export class OtoJog extends PlayerElement {
  #rotor: SVGGElement;
  #glow: SVGCircleElement;
  #icon: HTMLElement;
  #label: HTMLElement;
  #center: HTMLButtonElement;

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

  protected render(now: number) {
    const playing = this.player?.state === "playing";
    if (playing !== this.#shownPlaying) {
      this.#shownPlaying = playing;
      this.#icon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      this.#center.setAttribute("aria-label", playing ? "Pause" : "Play");
    }
    const turning = now - this.#lastTurn < 700;
    this.toggleAttribute("turning", turning);
    const text = turning && this.#cursor != null ? formatPrecise(this.#cursor) : "SCRUB";
    if (this.#label.textContent !== text) this.#label.textContent = text;
  }

  /** Turns the dial by whole notches, as a drag/wheel/key would. */
  turn(notches: number, { shift = false, ctrl = false } = {}) {
    if (notches === 0) return;
    const step = ctrl ? 1 : (shift ? 10 : 1) / this.fps;
    this.#angle = (this.#angle + notches * (ctrl ? 60 : shift ? 36 : 12)) % 360;
    this.#rotor.style.transform = `rotate(${this.#angle}deg)`;
    this.#glow.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 450, easing: "ease-out" });

    const now = performance.now();
    const player = this.player;
    if (this.#cursor == null || now - this.#lastTurn > RESYNC_AFTER_MS) {
      this.#cursor = player?.position() ?? 0;
    }
    this.#lastTurn = now;
    const duration = player?.duration ?? Infinity;
    const delta = notches * step;
    this.#cursor = Math.min(Math.max(this.#cursor + delta, 0), duration);

    if (player?.snapshot.path) this.#queueScrub(this.#cursor);
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
    // Up is positive, like scrolling up. Carry the remainder so slow drags still add up.
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
    let notches: number;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
      this.#wheelCarry += -e.deltaY / WHEEL_PIXELS_PER_NOTCH;
      notches = Math.trunc(this.#wheelCarry);
      // A mouse wheel detent (~100 px) is always at least one notch.
      if (notches === 0 && Math.abs(e.deltaY) >= WHEEL_PIXELS_PER_NOTCH) notches = -Math.sign(e.deltaY);
      this.#wheelCarry -= notches;
    } else {
      notches = -Math.sign(e.deltaY);
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
