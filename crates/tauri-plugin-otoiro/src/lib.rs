//! Tauri plugin around `otoiro`.
//!
//! Register with `.plugin(tauri_plugin_otoiro::init())`. The webview talks to it through
//! `plugin:otoiro|<command>`; state changes are pushed over `tauri::ipc::Channel`s registered
//! with `subscribe`, so the UI never has to poll.

use std::sync::{Arc, Mutex};

use otoiro::{Engine, EngineEvent, MediaInfo, Snapshot, Waveform};
use tauri::ipc::{Channel, Response};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

type Subscribers = Arc<Mutex<Vec<Channel<EngineEvent>>>>;

struct OtoiroState {
    engine: Engine,
    subscribers: Subscribers,
}

type CmdResult<T = ()> = Result<T, String>;

fn engine_err(e: otoiro::EngineError) -> String {
    e.to_string()
}

#[tauri::command]
fn subscribe(on_event: Channel<EngineEvent>, state: State<'_, OtoiroState>) -> Snapshot {
    state.subscribers.lock().unwrap().push(on_event);
    state.engine.snapshot()
}

#[tauri::command]
fn load(path: String, autoplay: Option<bool>, state: State<'_, OtoiroState>) -> CmdResult {
    state
        .engine
        .load(path, autoplay.unwrap_or(true))
        .map_err(engine_err)
}

#[tauri::command]
fn play(state: State<'_, OtoiroState>) -> CmdResult {
    state.engine.play().map_err(engine_err)
}

#[tauri::command]
fn pause(state: State<'_, OtoiroState>) -> CmdResult {
    state.engine.pause().map_err(engine_err)
}

#[tauri::command]
fn seek(position: f64, state: State<'_, OtoiroState>) -> CmdResult {
    state.engine.seek(position).map_err(engine_err)
}

#[tauri::command]
fn scrub(position: f64, state: State<'_, OtoiroState>) -> CmdResult {
    state.engine.scrub(position).map_err(engine_err)
}

#[tauri::command]
fn stop(state: State<'_, OtoiroState>) -> CmdResult {
    state.engine.stop().map_err(engine_err)
}

#[tauri::command]
fn set_volume(volume: f32, state: State<'_, OtoiroState>) -> CmdResult {
    state.engine.set_volume(volume).map_err(engine_err)
}

#[tauri::command]
fn snapshot(state: State<'_, OtoiroState>) -> Snapshot {
    state.engine.snapshot()
}

/// Runs blocking file work off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn media_info(path: String) -> CmdResult<MediaInfo> {
    blocking(move || otoiro::media_info(&path)).await
}

/// Raw image bytes (empty when the file has no cover). Sent as a binary IPC response so a
/// few hundred KB of JPEG doesn't get JSON-encoded as a number array.
#[tauri::command]
async fn cover_art(path: String) -> CmdResult<Response> {
    let cover = blocking(move || otoiro::cover_art(&path)).await?;
    Ok(Response::new(cover.map(|c| c.data).unwrap_or_default()))
}

#[tauri::command]
async fn waveform(path: String, buckets: Option<usize>) -> CmdResult<Waveform> {
    blocking(move || otoiro::waveform(&path, buckets.unwrap_or(2048))).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("otoiro")
        .invoke_handler(tauri::generate_handler![
            subscribe, load, play, pause, seek, scrub, stop, set_volume, snapshot, media_info,
            cover_art, waveform
        ])
        .setup(|app, _api| {
            let subscribers: Subscribers = Arc::default();
            let sink = subscribers.clone();
            let engine = Engine::new(move |event| {
                // Channels whose webview went away (reload, window closed) fail to send.
                sink.lock()
                    .unwrap()
                    .retain(|ch| ch.send(event.clone()).is_ok());
            })?;
            app.manage(OtoiroState {
                engine,
                subscribers,
            });
            Ok(())
        })
        .build()
}
