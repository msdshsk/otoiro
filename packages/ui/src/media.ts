import { invoke } from "@tauri-apps/api/core";

export interface MediaInfo {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: string | null;
  bpm: number | null;
  key: string | null;
  duration: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** MIME type of the embedded cover, or null when there is none. */
  coverType: string | null;
}

export interface WaveformData {
  duration: number;
  /** 0..1 per bucket. */
  peak: number[];
  /** 0..1 per bucket. */
  rms: number[];
  /** 0..1, overall spectral brightness of the track. */
  brightness: number;
  /** Estimated sections, covering the whole track. */
  sections: Section[];
  /** Start (seconds) of the likely chorus / climax. */
  highlight: number | null;
}

export interface Section {
  start: number;
  end: number;
  /** 0..1 relative intensity (loudest section = 1). */
  energy: number;
}

/** Tags and stream parameters, read without starting playback. */
export function getMediaInfo(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("plugin:otoiro|media_info", { path });
}

/** Embedded cover art as a Blob, or null. */
export async function getCoverArt(path: string, type = "image/jpeg"): Promise<Blob | null> {
  const bytes = await invoke<ArrayBuffer>("plugin:otoiro|cover_art", { path });
  return bytes.byteLength > 0 ? new Blob([bytes], { type }) : null;
}

/** Amplitude overview of the whole file. Decodes the file once, so expect ~0.3–1 s per track. */
export function getWaveform(path: string, buckets = 2048): Promise<WaveformData> {
  return invoke<WaveformData>("plugin:otoiro|waveform", { path, buckets });
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
