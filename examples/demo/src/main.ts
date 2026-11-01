import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DEFAULT_PALETTE,
  Player,
  applyPalette,
  bindMediaKeys,
  drawSoundArt,
  fileName,
  formatTime,
  getCoverArt,
  getMediaInfo,
  getWaveform,
  paletteFromImage,
  paletteFromSound,
  registerPaletteProperties,
  type MediaInfo,
} from "@otoiro/ui";

const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "alac", "aiff", "caf", "mka"];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = document.documentElement;
const card = $("drop-zone");
const title = $("title");
const artist = $("artist");
const chips = $("chips");
const error = $("error");
const cover = $<HTMLImageElement>("cover");
const artCanvas = $<HTMLCanvasElement>("art-canvas");
const backdrop = $<HTMLImageElement>("backdrop-img");
const seekbar = document.querySelector("oto-seekbar")!;

registerPaletteProperties();
applyPalette(root, DEFAULT_PALETTE);

const player = await Player.connect();
seekbar.player = player;
document.querySelector("oto-transport")!.player = player;
const jog = document.querySelector("oto-jog")!;
jog.player = player;
jog.unitLabels = {
  beat: "1拍",
  bar: "1小節",
  bars4: "4小節",
  section: "セクション",
  second: "1秒",
  seconds10: "10秒",
  frame: "1フレーム",
  frames10: "10フレーム",
  seconds: "{s}秒",
};
const highlightButton = $<HTMLButtonElement>("highlight");
$("prev-section").addEventListener("click", () => seekbar.previousSection());
$("next-section").addEventListener("click", () => seekbar.nextSection());
highlightButton.addEventListener("click", () => seekbar.jumpToHighlight());
const vocalsButton = $<HTMLButtonElement>("vocals");
vocalsButton.addEventListener("click", () => seekbar.jumpToVocals());
seekbar.markerLabels = { chorus: "サビ候補（推定）", vocalStart: "歌いだし（推定）" };

let current = 0;
let coverUrl: string | null = null;

function renderChips(info: MediaInfo | null, extra: string[] = []) {
  const items: [string, boolean][] = [];
  if (info?.bpm) items.push([`${info.bpm} BPM`, true]);
  if (info?.key) items.push([info.key, true]);
  if (info?.duration) items.push([formatTime(info.duration), false]);
  if (info?.sampleRate) items.push([`${(info.sampleRate / 1000).toFixed(1)} kHz`, false]);
  if (info?.channels) items.push([`${info.channels} ch`, false]);
  if (info?.genre) items.push([info.genre, false]);
  for (const e of extra) items.push([e, false]);
  chips.replaceChildren(
    ...items.map(([text, accent]) => {
      const el = document.createElement("span");
      el.className = accent ? "chip accent" : "chip";
      el.textContent = text;
      return el;
    }),
  );
}

/** Loads tags, artwork and waveform in parallel; each part updates the UI as it lands. */
async function describe(path: string) {
  const token = ++current;
  const stale = () => token !== current;

  title.textContent = fileName(path);
  artist.textContent = "";
  chips.replaceChildren();
  seekbar.waveform = null;
  artCanvas.getContext("2d")!.clearRect(0, 0, artCanvas.width, artCanvas.height);

  const infoTask = getMediaInfo(path).then((info) => {
    if (stale()) return info;
    title.textContent = info.title ?? fileName(path);
    artist.textContent = [info.artist ?? info.albumArtist, info.album, info.year].filter(Boolean).join(" · ");
    renderChips(info);
    jog.bpm = info.bpm;
    return info;
  });

  const coverTask = infoTask.then(async (info) => {
    const blob = info.coverType ? await getCoverArt(path, info.coverType) : null;
    if (stale()) return false;
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    coverUrl = blob ? URL.createObjectURL(blob) : null;
    cover.hidden = !coverUrl;
    backdrop.classList.toggle("visible", !!coverUrl);
    if (coverUrl) {
      cover.src = coverUrl;
      backdrop.src = coverUrl;
      applyPalette(root, await paletteFromImage(blob!));
    }
    return !!coverUrl;
  });

  const waveform = await getWaveform(path);
  if (stale()) return;
  seekbar.waveform = waveform;
  jog.sections = waveform.sections.map((s) => s.start);
  highlightButton.disabled = seekbar.highlights.length === 0;
  vocalsButton.disabled = waveform.vocalStart == null;

  const hasCover = await coverTask;
  if (stale() || hasCover) return;
  const loudness = waveform.rms.reduce((a, b) => a + b, 0) / Math.max(1, waveform.rms.length);
  const palette = paletteFromSound(waveform.brightness, loudness * 3, path);
  applyPalette(root, palette);
  drawSoundArt(artCanvas, waveform, palette);
}

player.on((event) => {
  if (event.type === "loaded") {
    error.hidden = true;
    describe(event.path).catch((e) => {
      error.textContent = String(e);
      error.hidden = false;
    });
  } else if (event.type === "error") {
    error.textContent = event.message;
    error.hidden = false;
  }
});

const load = (path: string) => player.load(path, true);

$("open").addEventListener("click", async () => {
  const path = await open({ multiple: false, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
  if (typeof path === "string") await load(path);
});

await getCurrentWebview().onDragDropEvent(({ payload }) => {
  card.classList.toggle("dragover", payload.type === "enter" || payload.type === "over");
  if (payload.type === "drop" && payload.paths.length > 0) void load(payload.paths[0]);
});

bindMediaKeys(player);

const initial = await invoke<string | null>("initial_path");
if (initial) await load(initial);
