import { afterEach, describe, expect, it } from "vitest";
import "../src/jog";
import type { OtoJog } from "../src/jog";
import { fakePlayer, nextFrame } from "./fake-player";

function mountJog(player: ReturnType<typeof fakePlayer>, attrs: Record<string, string> = {}) {
  const jog = document.createElement("oto-jog") as OtoJog;
  for (const [k, v] of Object.entries(attrs)) jog.setAttribute(k, v);
  document.body.append(jog);
  jog.player = player;
  return jog;
}

afterEach(() => document.body.replaceChildren());

describe("<oto-jog> while playing", () => {
  it("seeks instead of scrubbing, so playback is not paused", async () => {
    const player = fakePlayer("playing", 10);
    const jog = mountJog(player, { bpm: "120" });

    jog.turn(1);
    await nextFrame();

    expect(player.seek).toHaveBeenCalledWith(10.5);
    expect(player.scrub).not.toHaveBeenCalled();
    expect(player.pause).not.toHaveBeenCalled();
  });

  it("coalesces a fast turn into a single seek to the final position", async () => {
    const player = fakePlayer("playing", 10);
    const jog = mountJog(player, { bpm: "120" });

    for (let i = 0; i < 5; i++) jog.turn(1);
    await nextFrame();

    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(12.5);
  });

  it("moves forward when the wheel scrolls down", async () => {
    const player = fakePlayer("playing", 10);
    const jog = mountJog(player, { bpm: "120" });

    jog.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
    await nextFrame();

    expect(player.seek).toHaveBeenCalledWith(10.5);
  });

  it("scrubs (pausing) when pause-on-turn is set", async () => {
    const player = fakePlayer("playing", 10);
    const jog = mountJog(player, { bpm: "120", "pause-on-turn": "" });

    jog.turn(1);
    await nextFrame();

    expect(player.scrub).toHaveBeenCalledWith(10.5);
    expect(player.seek).not.toHaveBeenCalled();
  });

  it("jumps to the next section boundary without pausing", async () => {
    const player = fakePlayer("playing", 10);
    const jog = mountJog(player, { unit: "section" });
    jog.sections = [0, 24, 50];

    jog.turn(1);

    expect(player.seek).toHaveBeenCalledWith(24);
    expect(player.scrub).not.toHaveBeenCalled();
  });
});

describe("<oto-jog> while paused", () => {
  it("scrubs so the new position can be heard", async () => {
    const player = fakePlayer("paused", 10);
    const jog = mountJog(player, { bpm: "120" });

    jog.turn(-1);
    await nextFrame();

    expect(player.scrub).toHaveBeenCalledWith(9.5);
    expect(player.seek).not.toHaveBeenCalled();
  });
});
