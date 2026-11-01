import { PlayerElement } from "./base";
import { formatTime } from "./player";

const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>`;

const template = document.createElement("template");
template.innerHTML = `
<style>
  :host {
    --_accent: var(--oto-accent, #7c5cff);
    --_text: var(--oto-text, #f5f5f7);
    --_muted: var(--oto-muted, rgb(245 245 247 / 0.55));
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--_text);
    font: 500 13px/1 system-ui, sans-serif;
  }
  button {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--_accent);
    /* Accents are kept light for dark UIs, so a dark glyph reads better than white. */
    color: var(--oto-on-accent, var(--oto-base, #111118));
    cursor: pointer;
    box-shadow: 0 6px 20px color-mix(in srgb, var(--_accent) 45%, transparent);
    transition: transform 140ms cubic-bezier(.3,1.6,.5,1), filter 140ms;
  }
  button:hover { transform: scale(1.06); filter: brightness(1.1); }
  button:active { transform: scale(0.94); }
  button:disabled { opacity: 0.4; cursor: default; transform: none; }
  svg { width: 22px; height: 22px; fill: currentColor; }
  .time { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .total { color: var(--_muted); }
  .spacer { flex: 1; }
  input[type="range"] { width: 96px; accent-color: var(--_accent); }
</style>
<button part="play" aria-label="Play"></button>
<span class="time" part="time"><span class="current">0:00</span> <span class="total">/ --:--</span></span>
<span class="spacer"></span>
<input part="volume" type="range" min="0" max="1" step="0.01" aria-label="Volume" />
`;

/** `<oto-transport>`: play/pause, elapsed/total time, volume. */
export class OtoTransport extends PlayerElement {
  #button: HTMLButtonElement;
  #current: HTMLElement;
  #total: HTMLElement;
  #volume: HTMLInputElement;
  #shown = { playing: null as boolean | null, current: "", total: "" };

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));
    this.#button = root.querySelector("button")!;
    this.#current = root.querySelector(".current")!;
    this.#total = root.querySelector(".total")!;
    this.#volume = root.querySelector("input")!;

    this.#button.addEventListener("click", () => void this.player?.toggle());
    this.#volume.addEventListener("input", () => void this.player?.setVolume(Number(this.#volume.value)));
  }

  protected render(now: number) {
    const player = this.player;
    const playing = player?.state === "playing";
    if (playing !== this.#shown.playing) {
      this.#shown.playing = playing;
      this.#button.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      this.#button.setAttribute("aria-label", playing ? "Pause" : "Play");
    }
    this.#button.disabled = !player?.snapshot.path;

    const current = formatTime(player?.position(now) ?? 0);
    if (current !== this.#shown.current) this.#current.textContent = this.#shown.current = current;
    const total = `/ ${formatTime(player?.duration)}`;
    if (total !== this.#shown.total) this.#total.textContent = this.#shown.total = total;

    if (player && this.shadowRoot!.activeElement !== this.#volume) {
      this.#volume.value = String(player.snapshot.volume);
    }
  }
}

customElements.define("oto-transport", OtoTransport);

declare global {
  interface HTMLElementTagNameMap {
    "oto-transport": OtoTransport;
  }
}
