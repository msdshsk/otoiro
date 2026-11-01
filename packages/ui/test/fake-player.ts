import { vi } from "vitest";
import type { PlaybackState, Player } from "../src/player";

/** Stand-in for `Player` that records commands instead of talking to Tauri. */
export function fakePlayer(state: PlaybackState = "playing", position = 10) {
  const fake = {
    state,
    position: () => position,
    duration: 100,
    get snapshot() {
      return { state: fake.state, position, duration: 100, path: "song.mp3", volume: 0.5 };
    },
    seek: vi.fn(async (_: number) => {}),
    scrub: vi.fn(async (_: number) => {}),
    toggle: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  };
  return fake as typeof fake & Player;
}

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
