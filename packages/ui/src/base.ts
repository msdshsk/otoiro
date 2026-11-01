import type { EngineEvent, Player } from "./player";

/**
 * Shared plumbing for widgets: holds the `player`, runs a rAF loop while connected,
 * and forwards engine events.
 */
export abstract class PlayerElement extends HTMLElement {
  #player: Player | null = null;
  #unsubscribe: (() => void) | null = null;
  #raf = 0;

  get player(): Player | null {
    return this.#player;
  }

  set player(player: Player | null) {
    this.#unsubscribe?.();
    this.#player = player;
    this.#unsubscribe = player?.on((event) => this.onEvent(event)) ?? null;
    this.render(performance.now());
  }

  connectedCallback() {
    const loop = (now: number) => {
      this.render(now);
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#raf);
  }

  /** Called every animation frame while connected. Keep it cheap. */
  protected abstract render(now: number): void;

  protected onEvent(_event: EngineEvent): void {}
}
