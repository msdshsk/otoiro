import { PlayerElement } from "./base";
import type { WaveformData } from "./media";
import { formatTime } from "./player";

const KEY_STEP = 5;

export interface SeekbarMarkerLabels {
  /** Tooltip of the ★ chorus-candidate badges. */
  chorus: string;
  /** Tooltip of the ♪ vocal-entry badge. */
  vocalStart: string;
}

const DEFAULT_MARKER_LABELS: SeekbarMarkerLabels = {
  chorus: "Chorus (estimated)",
  vocalStart: "Vocals start (estimated)",
};

const template = document.createElement("template");
template.innerHTML = `
<style>
  :host {
    --_accent: var(--oto-accent, #7c5cff);
    --_accent-2: var(--oto-accent-2, #22d3ee);
    --_track: var(--oto-track, rgb(255 255 255 / 0.14));
    --_text: var(--oto-text, #f5f5f7);
    --_bubble: var(--oto-bubble, rgb(20 20 28 / 0.92));
    display: block;
    position: relative;
    height: 28px;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    outline: none;
  }
  .rail {
    position: absolute;
    inset: 50% 0 auto 0;
    height: 4px;
    translate: 0 -50%;
    border-radius: 999px;
    background: var(--_track);
    overflow: hidden;
    transition: height 160ms cubic-bezier(.2,.8,.2,1);
  }
  :host(:hover) .rail, :host([dragging]) .rail, :host(:focus-visible) .rail { height: 8px; }
  .fill, .hover-fill {
    position: absolute;
    inset: 0;
    transform-origin: left center;
    transform: scaleX(0);
  }
  .fill {
    background: linear-gradient(90deg, var(--_accent), var(--_accent-2));
    box-shadow: 0 0 12px color-mix(in srgb, var(--_accent) 60%, transparent);
  }
  .hover-fill {
    background: rgb(255 255 255 / 0.12);
    opacity: 0;
    transition: opacity 120ms;
  }
  :host(:hover) .hover-fill { opacity: 1; }
  .thumb {
    position: absolute;
    top: 50%;
    left: 0;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--_accent) 35%, transparent), 0 2px 8px rgb(0 0 0 / 0.4);
    scale: 0;
    transition: scale 160ms cubic-bezier(.3,1.6,.5,1);
    pointer-events: none;
  }
  :host(:hover) .thumb, :host(:focus-visible) .thumb { scale: 1; }
  :host([dragging]) .thumb { scale: 1.25; }
  .bubble {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    translate: -50% 4px;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--_bubble);
    color: var(--_text);
    font: 600 12px/1.4 ui-monospace, "Cascadia Mono", monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms, translate 160ms cubic-bezier(.2,.8,.2,1);
  }
  :host(:hover) .bubble, :host([dragging]) .bubble { opacity: 1; translate: -50% 0; }
  .delta { margin-left: 6px; opacity: 0.6; font-weight: 400; }

  /* Waveform mode */
  :host([has-waveform]) { height: var(--oto-wave-height, 72px); }
  .wave {
    position: absolute;
    inset: 0;
    display: none;
    transform-origin: center;
    transform: scaleY(0);
    transition: transform 520ms cubic-bezier(.2,.9,.25,1.15);
  }
  :host([has-waveform]) .wave { display: block; }
  :host([wave-ready]) .wave { transform: scaleY(1); }
  :host([has-waveform]) .rail, :host([has-waveform]) .thumb { display: none; }
  .layer {
    position: absolute;
    inset: 0;
    -webkit-mask: var(--_mask) 0 0 / 100% 100% no-repeat;
    mask: var(--_mask) 0 0 / 100% 100% no-repeat;
  }
  .layer.base { background: var(--oto-wave, rgb(255 255 255 / 0.22)); }
  .layer.hover { background: rgb(255 255 255 / 0.4); opacity: 0; transition: opacity 120ms; }
  :host(:hover) .layer.hover { opacity: 1; }
  .layer.played {
    background: linear-gradient(90deg, var(--_accent), var(--_accent-2));
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--_accent) 55%, transparent));
  }
  .marks { position: absolute; inset: 0; pointer-events: none; }
  .boundary {
    position: absolute;
    top: 2px;
    bottom: 2px;
    width: 1px;
    background: rgb(255 255 255 / 0.28);
  }
  .boundary::before {
    content: "";
    position: absolute;
    top: -2px;
    left: -2px;
    width: 5px;
    height: 3px;
    border-radius: 1px;
    background: rgb(255 255 255 / 0.55);
  }
  .highlight-band {
    position: absolute;
    top: 0;
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--_accent), var(--_accent-2));
    opacity: 0.85;
  }
  .highlight-badge {
    position: absolute;
    top: -9px;
    translate: -50% 0;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--_accent);
    color: var(--oto-on-accent, var(--oto-base, #111118));
    font: 700 11px/1 system-ui, sans-serif;
    box-shadow: 0 0 10px color-mix(in srgb, var(--_accent) 70%, transparent);
    cursor: pointer;
    pointer-events: auto;
    transition: scale 140ms cubic-bezier(.3,1.6,.5,1);
  }
  .highlight-badge:hover { scale: 1.2; }
  .vocal-band {
    position: absolute;
    bottom: 0;
    height: 2px;
    border-radius: 1px;
    background: rgb(255 255 255 / 0.55);
  }
  .vocal-badge {
    position: absolute;
    bottom: -8px;
    translate: -50% 0;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.6);
    border-radius: 50%;
    background: rgb(20 20 28 / 0.9);
    color: #fff;
    font: 700 10px/1 system-ui, sans-serif;
    cursor: pointer;
    pointer-events: auto;
    transition: scale 140ms cubic-bezier(.3,1.6,.5,1);
  }
  .vocal-badge:hover { scale: 1.2; }
  .playhead {
    position: absolute;
    top: -4px;
    bottom: -4px;
    left: -1px;
    width: 2px;
    border-radius: 1px;
    background: #fff;
    box-shadow: 0 0 10px color-mix(in srgb, var(--_accent) 80%, white);
    pointer-events: none;
  }
</style>
<div class="wave" part="wave">
  <div class="layer base"></div>
  <div class="layer hover"></div>
  <div class="layer played"></div>
  <div class="marks" part="marks"></div>
  <div class="playhead" part="playhead"></div>
</div>
<div class="rail" part="rail">
  <div class="hover-fill" part="hover-fill"></div>
  <div class="fill" part="fill"></div>
</div>
<div class="thumb" part="thumb"></div>
<div class="bubble" part="bubble"><span class="time"></span><span class="delta"></span></div>
`;

/**
 * `<oto-seekbar>`: a scrubbable timeline driven by `Player.position()` every frame.
 *
 * - Hover shows the time under the cursor.
 * - Dragging previews the target (with the offset from the current position) and seeks on
 *   release; Escape cancels.
 * - Keyboard: Space play/pause, ←/→ ±5s, Home/End, PageUp/PageDown previous/next section.
 * - With waveform analysis, section boundaries are marked, every chorus candidate gets a ★
 *   badge and band, and (unless `showVocals` is off) sung stretches get a line along the
 *   bottom with a ♪ badge at the vocal entry. `markerLabels` sets the tooltips.
 *
 * Set `waveform` to switch from a thin rail to a waveform timeline (played part in the accent
 * gradient, hovered part highlighted, glowing playhead).
 *
 * Styling: `--oto-accent`, `--oto-accent-2`, `--oto-track`, `--oto-wave`, `--oto-wave-height`,
 * `--oto-text`, `--oto-bubble`, and `::part(rail|fill|hover-fill|thumb|bubble|wave|playhead)`.
 */
export class OtoSeekbar extends PlayerElement {
  #fill: HTMLElement;
  #hoverFill: HTMLElement;
  #thumb: HTMLElement;
  #bubble: HTMLElement;
  #bubbleTime: HTMLElement;
  #bubbleDelta: HTMLElement;
  #wave: HTMLElement;
  #waveHover: HTMLElement;
  #wavePlayed: HTMLElement;
  #playhead: HTMLElement;
  #marks: HTMLElement;

  #waveform: WaveformData | null = null;
  #maskUrl: string | null = null;
  #maskWidth = 0;
  #maskJob = 0;
  #resizeObserver = new ResizeObserver(() => this.#scheduleMask());

  #hoverRatio: number | null = null;
  #dragRatio: number | null = null;
  #pointerId: number | null = null;
  #ariaText = "";
  #markerLabels: SeekbarMarkerLabels = DEFAULT_MARKER_LABELS;
  #showVocals = true;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));
    this.#fill = root.querySelector(".fill")!;
    this.#hoverFill = root.querySelector(".hover-fill")!;
    this.#thumb = root.querySelector(".thumb")!;
    this.#bubble = root.querySelector(".bubble")!;
    this.#bubbleTime = root.querySelector(".time")!;
    this.#bubbleDelta = root.querySelector(".delta")!;
    this.#wave = root.querySelector(".wave")!;
    this.#waveHover = root.querySelector(".layer.hover")!;
    this.#wavePlayed = root.querySelector(".layer.played")!;
    this.#playhead = root.querySelector(".playhead")!;
    this.#marks = root.querySelector(".marks")!;

    this.tabIndex = 0;
    this.setAttribute("role", "slider");
    this.setAttribute("aria-label", "Seek");

    this.addEventListener("pointerdown", this.#onPointerDown);
    this.addEventListener("pointermove", this.#onPointerMove);
    this.addEventListener("pointerup", this.#onPointerUp);
    this.addEventListener("pointercancel", this.#cancelDrag);
    this.addEventListener("pointerleave", () => (this.#hoverRatio = null));
    this.addEventListener("keydown", this.#onKeyDown);
  }

  get waveform(): WaveformData | null {
    return this.#waveform;
  }

  /** Waveform for the current track, or null to go back to the plain rail. */
  set waveform(waveform: WaveformData | null) {
    this.#waveform = waveform;
    this.removeAttribute("wave-ready");
    this.toggleAttribute("has-waveform", waveform != null);
    this.#maskWidth = 0;
    this.#scheduleMask();
    this.#renderMarks();
  }

  /** Section start times (seconds), first one at 0. Empty without waveform data. */
  get sectionStarts(): number[] {
    return this.#waveform?.sections.map((s) => s.start) ?? [];
  }

  /** Seeks to the next section boundary after the current position. */
  nextSection() {
    const pos = this.player?.position() ?? 0;
    const next = this.sectionStarts.find((t) => t > pos + 0.5);
    if (next != null) void this.player?.seek(next);
  }

  /** Seeks to the start of the current section, or the previous one when already near it. */
  previousSection() {
    const pos = this.player?.position() ?? 0;
    const prev = this.sectionStarts.filter((t) => t < pos - 1.5).pop();
    void this.player?.seek(prev ?? 0);
  }

  /** Overrides marker tooltips (e.g. for localisation). */
  set markerLabels(labels: Partial<SeekbarMarkerLabels>) {
    this.#markerLabels = { ...DEFAULT_MARKER_LABELS, ...labels };
    this.#renderMarks();
  }

  /** Whether to draw vocal stretches and the vocal-entry marker (default true). */
  get showVocals(): boolean {
    return this.#showVocals;
  }

  set showVocals(show: boolean) {
    this.#showVocals = show;
    this.#renderMarks();
  }

  /**
   * Chorus candidates (seconds): every detected chorus occurrence, or the single loudness
   * highlight when the track has no recognisable repetition.
   */
  get highlights(): number[] {
    const w = this.#waveform;
    if (!w) return [];
    if (w.choruses.length > 0) return w.choruses.map((c) => c.start);
    return w.highlight != null ? [w.highlight] : [];
  }

  /** Seeks to the next chorus candidate after the current position, wrapping to the first. */
  jumpToHighlight() {
    const all = this.highlights;
    if (all.length === 0) return;
    const pos = this.player?.position() ?? 0;
    void this.player?.seek(all.find((t) => t > pos + 1) ?? all[0]);
  }

  /** Seeks to where the singing starts, if known. */
  jumpToVocals() {
    const t = this.#waveform?.vocalStart;
    if (t != null) void this.player?.seek(t);
  }

  #renderMarks() {
    const waveform = this.#waveform;
    this.#marks.replaceChildren();
    if (!waveform || waveform.duration <= 0) return;
    const pct = (t: number) => `${(t / waveform.duration) * 100}%`;
    const width = (a: number, b: number) => `${((b - a) / waveform.duration) * 100}%`;
    const labels = this.#markerLabels;

    for (const section of waveform.sections.slice(1)) {
      const line = document.createElement("div");
      line.className = "boundary";
      line.style.left = pct(section.start);
      this.#marks.append(line);
    }

    if (this.#showVocals) {
      for (const span of waveform.vocals) {
        const bar = document.createElement("div");
        bar.className = "vocal-band";
        bar.style.left = pct(span.start);
        bar.style.width = width(span.start, span.end);
        this.#marks.append(bar);
      }
      if (waveform.vocalStart != null) {
        this.#marks.append(
          this.#badge("vocal-badge", "vocal", "♪", labels.vocalStart, pct(waveform.vocalStart), () =>
            this.jumpToVocals(),
          ),
        );
      }
    }

    const choruses: { start: number; end: number }[] =
      waveform.choruses.length > 0
        ? waveform.choruses
        : waveform.sections.filter((s) => s.start === waveform.highlight);
    for (const chorus of choruses) {
      const band = document.createElement("div");
      band.className = "highlight-band";
      band.style.left = pct(chorus.start);
      band.style.width = width(chorus.start, chorus.end);
      this.#marks.append(band);
    }
    for (const t of this.highlights) {
      this.#marks.append(
        this.#badge("highlight-badge", "highlight", "★", labels.chorus, pct(t), () => {
          void this.player?.seek(t);
        }),
      );
    }
  }

  #badge(className: string, part: string, glyph: string, title: string, left: string, onClick: () => void) {
    const badge = document.createElement("button");
    badge.className = className;
    badge.setAttribute("part", part);
    badge.textContent = glyph;
    badge.title = title;
    badge.style.left = left;
    badge.addEventListener("pointerdown", (e) => e.stopPropagation());
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return badge;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#resizeObserver.disconnect();
  }

  #scheduleMask() {
    cancelAnimationFrame(this.#maskJob);
    this.#maskJob = requestAnimationFrame(() => void this.#drawMask());
  }

  /**
   * Draws the waveform once into an alpha mask; the colours come from CSS, so palette changes
   * animate without redrawing and each frame only moves a clip edge.
   */
  async #drawMask() {
    const waveform = this.#waveform;
    const width = this.clientWidth;
    const height = this.clientHeight;
    if (!waveform || width === 0 || height === 0 || width === this.#maskWidth) return;
    this.#maskWidth = width;

    const dpr = window.devicePixelRatio || 1;
    const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr));
    const ctx = canvas.getContext("2d")!;
    const bar = Math.max(1, Math.round(2 * dpr));
    const gap = Math.max(1, Math.round(1 * dpr));
    const bars = Math.floor(canvas.width / (bar + gap));
    const mid = canvas.height / 2;
    const { peak, rms } = waveform;
    const n = peak.length;
    // Normalise so quiet tracks still read, but don't blow up near-silence.
    const gain = Math.min(1 / Math.max(...peak, 1e-3), 4);

    for (let i = 0; i < bars; i++) {
      const start = Math.floor((i * n) / bars);
      const end = Math.max(start + 1, Math.floor(((i + 1) * n) / bars));
      let p = 0;
      let r = 0;
      for (let j = start; j < end && j < n; j++) {
        p = Math.max(p, peak[j]);
        r = Math.max(r, rms[j]);
      }
      const x = i * (bar + gap);
      const ph = Math.max(dpr, Math.min(1, p * gain) * mid);
      const rh = Math.max(dpr, Math.min(1, r * gain * 1.4) * mid);
      ctx.fillStyle = "rgb(0 0 0 / 0.42)";
      ctx.fillRect(x, mid - ph, bar, ph * 2);
      ctx.fillStyle = "#000";
      ctx.fillRect(x, mid - rh, bar, rh * 2);
    }

    const blob = await canvas.convertToBlob();
    if (waveform !== this.#waveform) return;
    if (this.#maskUrl) URL.revokeObjectURL(this.#maskUrl);
    this.#maskUrl = URL.createObjectURL(blob);
    this.#wave.style.setProperty("--_mask", `url("${this.#maskUrl}")`);
    // Next frame, so the grow-in transition starts from the collapsed state.
    requestAnimationFrame(() => this.toggleAttribute("wave-ready", true));
  }

  protected render(now: number) {
    const player = this.player;
    const duration = player?.duration ?? 0;
    const position = player?.position(now) ?? 0;
    const playedRatio = duration > 0 ? position / duration : 0;
    const shownRatio = this.#dragRatio ?? playedRatio;
    const width = this.clientWidth;

    this.#fill.style.transform = `scaleX(${shownRatio})`;
    this.#thumb.style.transform = `translateX(${shownRatio * width}px)`;
    this.#hoverFill.style.transform = `scaleX(${this.#hoverRatio ?? 0})`;
    if (this.#waveform) {
      this.#wavePlayed.style.clipPath = `inset(0 ${(1 - shownRatio) * 100}% 0 0)`;
      this.#waveHover.style.clipPath = `inset(0 ${(1 - (this.#hoverRatio ?? 0)) * 100}% 0 0)`;
      this.#playhead.style.transform = `translateX(${shownRatio * width}px)`;
    }

    const bubbleRatio = this.#dragRatio ?? this.#hoverRatio;
    if (bubbleRatio != null && duration > 0) {
      const t = bubbleRatio * duration;
      this.#bubble.style.left = `${Math.min(Math.max(bubbleRatio * width, 28), width - 28)}px`;
      this.#bubbleTime.textContent = formatTime(t);
      this.#bubbleDelta.textContent =
        this.#dragRatio != null ? `${t >= position ? "+" : "−"}${formatTime(Math.abs(t - position))}` : "";
    }

    const ariaText = `${formatTime(position)} / ${formatTime(duration)}`;
    if (ariaText !== this.#ariaText) {
      this.#ariaText = ariaText;
      this.setAttribute("aria-valuemin", "0");
      this.setAttribute("aria-valuemax", String(Math.round(duration)));
      this.setAttribute("aria-valuenow", String(Math.round(position)));
      this.setAttribute("aria-valuetext", ariaText);
    }
  }

  #ratioAt(clientX: number): number {
    const rect = this.getBoundingClientRect();
    return rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0;
  }

  #onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.player?.duration) return;
    this.#pointerId = e.pointerId;
    this.setPointerCapture(e.pointerId);
    this.#dragRatio = this.#ratioAt(e.clientX);
    this.toggleAttribute("dragging", true);
  };

  #onPointerMove = (e: PointerEvent) => {
    const ratio = this.#ratioAt(e.clientX);
    this.#hoverRatio = ratio;
    if (this.#pointerId === e.pointerId) this.#dragRatio = ratio;
  };

  #onPointerUp = (e: PointerEvent) => {
    if (this.#pointerId !== e.pointerId) return;
    const ratio = this.#dragRatio;
    this.#endDrag();
    const duration = this.player?.duration;
    if (ratio != null && duration) {
      void this.player!.seek(ratio * duration);
      this.dispatchEvent(new CustomEvent("oto-seek", { detail: { position: ratio * duration }, bubbles: true }));
    }
  };

  #cancelDrag = () => this.#endDrag();

  #endDrag() {
    if (this.#pointerId != null && this.hasPointerCapture(this.#pointerId)) {
      this.releasePointerCapture(this.#pointerId);
    }
    this.#pointerId = null;
    this.#dragRatio = null;
    this.removeAttribute("dragging");
  }

  #onKeyDown = (e: KeyboardEvent) => {
    const player = this.player;
    const duration = player?.duration;
    if (!player || !duration) return;
    if (e.key === " ") {
      // Same as the jog: play/pause when focused, marked as handled for bindMediaKeys().
      e.preventDefault();
      if (!e.repeat) void player.toggle();
      return;
    }
    if (e.key === "Escape" && this.#dragRatio != null) {
      this.#endDrag();
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      if (e.key === "PageDown") this.nextSection();
      else this.previousSection();
      return;
    }
    const pos = player.position();
    const target =
      e.key === "ArrowLeft" ? pos - KEY_STEP
      : e.key === "ArrowRight" ? pos + KEY_STEP
      : e.key === "Home" ? 0
      : e.key === "End" ? duration
      : null;
    if (target == null) return;
    e.preventDefault();
    void player.seek(target);
  };
}

customElements.define("oto-seekbar", OtoSeekbar);

declare global {
  interface HTMLElementTagNameMap {
    "oto-seekbar": OtoSeekbar;
  }
}
