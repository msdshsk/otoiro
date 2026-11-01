const COMMANDS: &[&str] = &[
    "subscribe",
    "load",
    "play",
    "pause",
    "seek",
    "scrub",
    "stop",
    "set_volume",
    "snapshot",
    "media_info",
    "cover_art",
    "waveform",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
