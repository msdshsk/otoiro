//! Native audio playback engine.
//!
//! Design notes:
//! - The output device is opened once and kept running. While paused the callback writes
//!   silence instead of tearing the stream down, so pause/seek never re-open the device.
//! - Position is derived from the samples the audio callback actually handed to the device,
//!   corrected by the device latency reported by cpal. It is never a wall-clock guess.
//! - Seeking uses the demuxer's seek (no decode-and-discard from the start of the file).
//!   Stale audio is invalidated with a generation counter.

mod control;
mod info;
mod output;
mod source;
mod waveform;

use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;

use serde::Serialize;

use output::Shared;

pub use info::{cover_art, media_info, CoverArt, MediaInfo};
pub use waveform::{waveform, Waveform};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("audio output: {0}")]
    Output(String),
    #[error("engine thread is gone")]
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    Idle,
    Loading,
    Playing,
    Paused,
    Ended,
}

/// Point-in-time view of the player.
///
/// `position` is the audible position at the moment the snapshot was taken. A UI can
/// interpolate from it with `position + elapsed` while `state == Playing`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: PlaybackState,
    pub position: f64,
    pub duration: Option<f64>,
    pub path: Option<String>,
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    /// Emitted on every state change and periodically while playing (drift correction).
    #[serde(rename_all = "camelCase")]
    Snapshot { snapshot: Snapshot },
    #[serde(rename_all = "camelCase")]
    Loaded {
        path: String,
        duration: Option<f64>,
        sample_rate: u32,
        channels: usize,
    },
    #[serde(rename_all = "camelCase")]
    Ended { path: String },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

pub(crate) enum Command {
    Load { path: String, autoplay: bool },
    Play,
    Pause,
    Seek(f64),
    Stop,
    SetVolume(f32),
}

/// Handle to the engine. Cheap to clone; all clones talk to the same control thread.
/// The thread exits once every handle has been dropped.
#[derive(Clone)]
pub struct Engine {
    tx: Sender<Command>,
    shared: Arc<Shared>,
}

impl Engine {
    /// Starts the control thread and opens the default output device.
    ///
    /// `on_event` is called from the control thread, never from the audio callback.
    pub fn new(on_event: impl Fn(EngineEvent) + Send + 'static) -> Result<Self, EngineError> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();

        thread::Builder::new()
            .name("otoiro".into())
            .spawn(move || control::run(rx, ready_tx, Box::new(on_event)))
            .map_err(|e| EngineError::Output(e.to_string()))?;

        let shared = ready_rx
            .recv()
            .map_err(|_| EngineError::Disconnected)?
            .map_err(EngineError::Output)?;

        Ok(Self { tx, shared })
    }

    pub fn load(&self, path: impl Into<String>, autoplay: bool) -> Result<(), EngineError> {
        self.send(Command::Load {
            path: path.into(),
            autoplay,
        })
    }

    pub fn play(&self) -> Result<(), EngineError> {
        self.send(Command::Play)
    }

    pub fn pause(&self) -> Result<(), EngineError> {
        self.send(Command::Pause)
    }

    pub fn seek(&self, seconds: f64) -> Result<(), EngineError> {
        self.send(Command::Seek(seconds.max(0.0)))
    }

    pub fn stop(&self) -> Result<(), EngineError> {
        self.send(Command::Stop)
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), EngineError> {
        self.send(Command::SetVolume(volume.clamp(0.0, 1.0)))
    }

    pub fn snapshot(&self) -> Snapshot {
        self.shared.snapshot()
    }

    fn send(&self, cmd: Command) -> Result<(), EngineError> {
        self.tx.send(cmd).map_err(|_| EngineError::Disconnected)
    }
}
