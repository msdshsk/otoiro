import { afterEach, describe, expect, it } from "vitest";
import { bindMediaKeys } from "../src/keys";
import { fakePlayer } from "./fake-player";

const space = (target: EventTarget, init: KeyboardEventInit = {}) => {
  const down = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true });
  target.dispatchEvent(up);
  return { down, up };
};

let unbind = () => {};
afterEach(() => {
  unbind();
  document.body.replaceChildren();
});

describe("bindMediaKeys", () => {
  it("toggles playback on Space", () => {
    const player = fakePlayer();
    unbind = bindMediaKeys(player);
    space(document.body);
    expect(player.toggle).toHaveBeenCalledTimes(1);
  });

  it("leaves Space alone in text fields", () => {
    const player = fakePlayer();
    unbind = bindMediaKeys(player);
    const input = Object.assign(document.createElement("input"), { type: "search" });
    document.body.append(input);
    const { down } = space(input);
    expect(player.toggle).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(false);
  });

  it("takes Space over on a focused button so it isn't pressed again", () => {
    const player = fakePlayer();
    unbind = bindMediaKeys(player);
    const button = document.createElement("button");
    document.body.append(button);
    const { down, up } = space(button);
    expect(player.toggle).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
  });

  it("skips events a widget already handled", () => {
    const player = fakePlayer();
    unbind = bindMediaKeys(player);
    const widget = document.createElement("div");
    widget.addEventListener("keydown", (e) => e.preventDefault());
    document.body.append(widget);
    space(widget);
    expect(player.toggle).not.toHaveBeenCalled();
  });

  it("ignores Space with Ctrl held", () => {
    const player = fakePlayer();
    unbind = bindMediaKeys(player);
    space(document.body, { ctrlKey: true });
    expect(player.toggle).not.toHaveBeenCalled();
  });
});
