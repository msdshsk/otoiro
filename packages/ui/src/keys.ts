import type { Player } from "./player";

export interface MediaKeyOptions {
  /** Where to listen. Default: `window`. */
  target?: EventTarget;
  /** Return true to leave an event alone (e.g. while a modal dialog is open). */
  ignore?: (event: KeyboardEvent) => boolean;
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Elements where Space types or picks something, so it must not be taken over. */
function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.getAttribute("role") === "textbox") return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type);
}

/**
 * App-wide play/pause on Space and the keyboard's media Play/Pause key.
 *
 * Space is left alone in text fields, selects and contenteditable, with Ctrl/Alt/Meta held,
 * and when something already handled the key (`defaultPrevented`, which the Otoiro widgets
 * set). On buttons and checkboxes Space is taken over: otherwise the last clicked button
 * (say, a track's play button) would be pressed again instead of pausing. Enter still
 * activates them.
 *
 * Returns a function that removes the listeners.
 */
export function bindMediaKeys(player: Player, options: MediaKeyOptions = {}): () => void {
  const target = options.target ?? window;
  let swallowKeyUp = false;

  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key === "MediaPlayPause") {
      e.preventDefault();
      void player.toggle();
      return;
    }
    if (e.code !== "Space" || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    if (isEditable(e.target) || options.ignore?.(e)) return;
    e.preventDefault();
    swallowKeyUp = true;
    if (!e.repeat && player.snapshot.path) void player.toggle();
  };

  // Buttons activate on Space keyup; cancel that too so the focused button isn't clicked.
  const onKeyUp = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.code === "Space" && swallowKeyUp) {
      e.preventDefault();
      swallowKeyUp = false;
    }
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
  };
}
