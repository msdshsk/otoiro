//! The control thread: owns the output stream and the decoder, handles commands, keeps the
//! queue topped up and reports state changes.

use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::output::{self, Shared};
use crate::source::Source;
use crate::{Command, EngineEvent, PlaybackState};

/// How much decoded audio to keep queued ahead of the device.
const BUFFER_AHEAD: Duration = Duration::from_millis(500);
/// Upper bound on decode work per loop iteration so commands stay responsive.
const MAX_CHUNKS_PER_PUMP: usize = 8;
const IDLE_WAIT: Duration = Duration::from_millis(10);
const TICK_INTERVAL: Duration = Duration::from_millis(250);

type EventSink = Box<dyn Fn(EngineEvent) + Send>;

pub(crate) fn run(
    rx: Receiver<Command>,
    ready: Sender<Result<Arc<Shared>, String>>,
    on_event: EventSink,
) {
    let (stream, shared) = match output::open() {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(shared.clone()));
    // Keep the stream alive for the lifetime of this thread.
    let _stream = stream;

    let target_frames = (shared.rate as f64 * BUFFER_AHEAD.as_secs_f64()) as usize;
    let mut ctl = Control {
        shared,
        source: None,
        on_event,
        target_frames,
        last_tick: Instant::now(),
    };

    loop {
        let wait = if ctl.wants_data() { Duration::ZERO } else { IDLE_WAIT };
        match rx.recv_timeout(wait) {
            Ok(cmd) => ctl.handle(cmd),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        ctl.pump();
        ctl.check_end();
        ctl.tick();
    }
}

struct Control {
    shared: Arc<Shared>,
    source: Option<Source>,
    on_event: EventSink,
    target_frames: usize,
    last_tick: Instant,
}

impl Control {
    fn handle(&mut self, cmd: Command) {
        match cmd {
            Command::Load { path, autoplay } => self.load(path, autoplay),
            Command::Play => {
                let state = self.state();
                if state == PlaybackState::Ended {
                    self.seek(0.0);
                }
                if matches!(state, PlaybackState::Paused | PlaybackState::Ended) {
                    self.shared.paused.store(false, Ordering::Relaxed);
                    self.set_state(PlaybackState::Playing);
                }
            }
            Command::Pause => {
                if self.state() == PlaybackState::Playing {
                    self.shared.paused.store(true, Ordering::Relaxed);
                    self.set_state(PlaybackState::Paused);
                }
            }
            Command::Seek(t) => {
                self.seek(t);
                self.emit_snapshot();
            }
            Command::Stop => {
                self.source = None;
                self.reset_queue(0.0);
                self.shared.paused.store(true, Ordering::Relaxed);
                {
                    let mut meta = self.shared.meta.lock().unwrap();
                    meta.path = None;
                    meta.duration = None;
                }
                self.set_state(PlaybackState::Idle);
            }
            Command::SetVolume(v) => {
                self.shared.set_volume(v);
                self.emit_snapshot();
            }
        }
    }

    fn load(&mut self, path: String, autoplay: bool) {
        self.shared.paused.store(true, Ordering::Relaxed);
        self.reset_queue(0.0);
        self.set_state(PlaybackState::Loading);

        match Source::open(&path, self.shared.rate, self.shared.channels) {
            Ok(source) => {
                {
                    let mut meta = self.shared.meta.lock().unwrap();
                    meta.path = Some(path.clone());
                    meta.duration = source.duration;
                }
                (self.on_event)(EngineEvent::Loaded {
                    path,
                    duration: source.duration,
                    sample_rate: source.sample_rate,
                    channels: source.channels,
                });
                self.source = Some(source);
                // Fill the queue before un-pausing so playback starts without an underrun.
                self.pump();
                self.shared.paused.store(!autoplay, Ordering::Relaxed);
                self.set_state(if autoplay {
                    PlaybackState::Playing
                } else {
                    PlaybackState::Paused
                });
            }
            Err(message) => {
                self.source = None;
                {
                    let mut meta = self.shared.meta.lock().unwrap();
                    meta.path = None;
                    meta.duration = None;
                }
                (self.on_event)(EngineEvent::Error { message });
                self.set_state(PlaybackState::Idle);
            }
        }
    }

    fn seek(&mut self, t: f64) {
        let Some(duration) = self.source.as_ref().map(|s| s.duration) else {
            return;
        };
        let t = duration.map_or(t, |d| t.min(d));
        // Invalidate queued audio first, then reposition the decoder. Both happen on this
        // thread, so nothing from before the seek can sneak back into the queue.
        self.reset_queue(t);
        let source = self.source.as_mut().expect("checked above");
        if let Err(message) = source.seek(t) {
            (self.on_event)(EngineEvent::Error { message });
        }
        if self.state() == PlaybackState::Ended {
            self.set_state_silent(PlaybackState::Paused);
        }
    }

    fn reset_queue(&self, head_pos: f64) {
        let stale = self.shared.queue.lock().unwrap().reset(head_pos);
        drop(stale);
    }

    fn wants_data(&self) -> bool {
        match &self.source {
            Some(s) if !s.is_eof() => {
                self.shared.queue.lock().unwrap().buffered_frames < self.target_frames
            }
            _ => false,
        }
    }

    fn pump(&mut self) {
        for _ in 0..MAX_CHUNKS_PER_PUMP {
            if !self.wants_data() {
                return;
            }
            let Some(source) = self.source.as_mut() else {
                return;
            };
            let result = source.next_chunk();
            let eof = source.is_eof();
            match result {
                Ok(chunk) => {
                    let mut q = self.shared.queue.lock().unwrap();
                    if let Some(samples) = chunk {
                        q.buffered_frames += samples.len() / self.shared.channels;
                        q.chunks.push_back(output::Chunk { samples, read: 0 });
                    }
                    if eof {
                        q.source_done = true;
                    }
                }
                Err(message) => {
                    log::warn!("decode error: {message}");
                    self.shared.queue.lock().unwrap().source_done = true;
                    self.source = None;
                    (self.on_event)(EngineEvent::Error { message });
                    return;
                }
            }
        }
    }

    fn check_end(&mut self) {
        if self.state() != PlaybackState::Playing {
            return;
        }
        let drained = {
            let q = self.shared.queue.lock().unwrap();
            q.source_done && q.chunks.is_empty()
        };
        if drained {
            self.shared.paused.store(true, Ordering::Relaxed);
            let path = self.shared.meta.lock().unwrap().path.clone();
            self.set_state(PlaybackState::Ended);
            if let Some(path) = path {
                (self.on_event)(EngineEvent::Ended { path });
            }
        }
    }

    fn tick(&mut self) {
        if self.state() == PlaybackState::Playing && self.last_tick.elapsed() >= TICK_INTERVAL {
            self.emit_snapshot();
        }
    }

    fn state(&self) -> PlaybackState {
        self.shared.meta.lock().unwrap().state
    }

    fn set_state(&mut self, state: PlaybackState) {
        self.set_state_silent(state);
        self.emit_snapshot();
    }

    fn set_state_silent(&mut self, state: PlaybackState) {
        self.shared.meta.lock().unwrap().state = state;
    }

    fn emit_snapshot(&mut self) {
        self.last_tick = Instant::now();
        (self.on_event)(EngineEvent::Snapshot {
            snapshot: self.shared.snapshot(),
        });
    }
}
