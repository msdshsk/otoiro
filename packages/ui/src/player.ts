import { Channel, invoke } from "@tauri-apps/api/core";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended";

export interface Snapshot {
  state: PlaybackState;
  /** Audible position (seconds) at the moment the backend took the snapshot. */
  position: number;
  duration: number | null;
  path: string | null;
  volume: number;
}

export type EngineEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "loaded"; path: string; duration: number | null; sampleRate: number; channels: number }
  | { type: "ended"; path: string }
  | { type: "error"; message: string };

export type PlayerListener = (event: EngineEvent, player: Player) => void;

const IDLE: Snapshot = { state: "idle", position: 0, duration: null, path: null, volume: 0.5 };

const cmd = <T = void>(name: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:otoiro|${name}`, args);

/**
 * Client for `tauri-plugin-otoiro`.
 *
 * The backend pushes a snapshot on every state change (plus a slow heartbeat while playing).
 * Between snapshots, `position()` extrapolates locally, so widgets can redraw every frame
 * without any IPC traffic.
 */
export class Player {
  #snapshot: Snapshot = IDLE;
  #anchor = performance.now();
  #listeners = new Set<PlayerListener>();

  private constructor() {}

  static async connect(): Promise<Player> {
    const player = new Player();
    const channel = new Channel<EngineEvent>();
    channel.onmessage = (event) => player.#receive(event);
    player.#setSnapshot(await cmd<Snapshot>("subscribe", { onEvent: channel }));
    return player;
  }

  get snapshot(): Readonly<Snapshot> {
    return this.#snapshot;
  }

  get state(): PlaybackState {
    return this.#snapshot.state;
  }

  get duration(): number | null {
    return this.#snapshot.duration;
  }

  /** Current audible position, extrapolated from the last snapshot. */
  position(now = performance.now()): number {
    const s = this.#snapshot;
    if (s.state !== "playing") return s.position;
    const p = s.position + (now - this.#anchor) / 1000;
    return s.duration == null ? p : Math.min(p, s.duration);
  }

  on(listener: PlayerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  load(path: string, autoplay = true) {
    return cmd("load", { path, autoplay });
  }

  play() {
    return cmd("play");
  }

  pause() {
    return cmd("pause");
  }

  toggle() {
    return this.state === "playing" ? this.pause() : this.play();
  }

  seek(position: number) {
    // Optimistic: move the local clock now so the UI doesn't snap back while the
    // confirmation is in flight.
    const clamped = this.#clamp(position);
    this.#setSnapshot({ ...this.#snapshot, position: clamped });
    return cmd("seek", { position: clamped });
  }

  #clamp(position: number) {
    const duration = this.#snapshot.duration;
    return Math.max(0, duration == null ? position : Math.min(position, duration));
  }

  /**
   * Jumps to `position` and plays a short grain there, leaving playback paused. Call it on
   * every step of a jog/drag gesture for audible scrubbing.
   */
  scrub(position: number) {
    const clamped = this.#clamp(position);
    this.#setSnapshot({ ...this.#snapshot, state: this.#snapshot.path ? "paused" : this.#snapshot.state, position: clamped });
    return cmd("scrub", { position: clamped });
  }

  stop() {
    return cmd("stop");
  }

  setVolume(volume: number) {
    this.#setSnapshot({ ...this.#snapshot, volume });
    return cmd("set_volume", { volume });
  }

  #receive(event: EngineEvent) {
    if (event.type === "snapshot") this.#setSnapshot(event.snapshot);
    for (const listener of this.#listeners) listener(event, this);
  }

  #setSnapshot(snapshot: Snapshot) {
    this.#snapshot = snapshot;
    this.#anchor = performance.now();
  }
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
