//! Output side: the cpal stream, the sample queue it drains, and the playback clock.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};

use crate::{PlaybackState, Snapshot};

/// Scrub grain envelope: a short fade in avoids a click at the jump, a longer fade out makes
/// rapid grains read as a continuous "tape" sound rather than a series of pops.
const GRAIN_FADE_IN: Duration = Duration::from_millis(3);
const GRAIN_FADE_OUT: Duration = Duration::from_millis(25);

/// Interleaved samples already converted to the device rate and channel count.
pub(crate) struct Chunk {
    pub samples: Vec<f32>,
    pub read: usize,
}

pub(crate) struct Queue {
    /// Bumped on every seek/load/stop so the callback never plays stale audio.
    pub generation: u64,
    pub chunks: VecDeque<Chunk>,
    pub buffered_frames: usize,
    /// Media position (seconds) of the next frame the callback will pull.
    pub head_pos: f64,
    /// The decoder reached the end of the stream for this generation.
    pub source_done: bool,
}

impl Queue {
    /// Invalidates everything queued and returns the old chunks so the caller can drop
    /// them outside the lock.
    pub fn reset(&mut self, head_pos: f64) -> VecDeque<Chunk> {
        self.generation += 1;
        self.buffered_frames = 0;
        self.head_pos = head_pos;
        self.source_done = false;
        std::mem::take(&mut self.chunks)
    }
}

/// Written by the audio callback once per buffer.
#[derive(Clone, Copy)]
struct Clock {
    generation: u64,
    /// Media position of the first frame written in the last callback.
    start: f64,
    /// Media position just after the last frame written in the last callback.
    end: f64,
    /// Position at which the current generation started (seek target).
    floor: f64,
    /// When the last callback ran, and how long until its first frame becomes audible.
    at: Instant,
    latency: Duration,
}

pub(crate) struct Meta {
    pub state: PlaybackState,
    pub duration: Option<f64>,
    pub path: Option<String>,
}

pub(crate) struct Shared {
    pub(crate) queue: Mutex<Queue>,
    clock: Mutex<Option<Clock>>,
    pub(crate) paused: AtomicBool,
    volume_bits: AtomicU32,
    /// While paused, this many frames may still play (a scrub grain), out of `grain_total`.
    grain_left: AtomicU64,
    grain_total: AtomicU64,
    pub(crate) meta: Mutex<Meta>,
    pub(crate) rate: u32,
    pub(crate) channels: usize,
}

impl Shared {
    fn new(rate: u32, channels: usize) -> Self {
        Self {
            queue: Mutex::new(Queue {
                generation: 0,
                chunks: VecDeque::new(),
                buffered_frames: 0,
                head_pos: 0.0,
                source_done: false,
            }),
            clock: Mutex::new(None),
            paused: AtomicBool::new(true),
            volume_bits: AtomicU32::new(0.5f32.to_bits()),
            grain_left: AtomicU64::new(0),
            grain_total: AtomicU64::new(0),
            meta: Mutex::new(Meta {
                state: PlaybackState::Idle,
                duration: None,
                path: None,
            }),
            rate,
            channels,
        }
    }

    pub(crate) fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Relaxed))
    }

    pub(crate) fn set_volume(&self, v: f32) {
        self.volume_bits.store(v.to_bits(), Ordering::Relaxed);
    }

    /// Lets `duration` worth of audio through while paused.
    pub(crate) fn start_grain(&self, duration: Duration) {
        let frames = (duration.as_secs_f64() * self.rate as f64) as u64;
        self.grain_left.store(0, Ordering::Relaxed);
        self.grain_total.store(frames, Ordering::Relaxed);
        self.grain_left.store(frames, Ordering::Relaxed);
    }

    pub(crate) fn cancel_grain(&self) {
        self.grain_left.store(0, Ordering::Relaxed);
    }

    /// Audible media position right now.
    pub(crate) fn position(&self) -> f64 {
        let (generation, head) = {
            let q = self.queue.lock().unwrap();
            (q.generation, q.head_pos)
        };
        let clock = *self.clock.lock().unwrap();
        match clock {
            Some(c) if c.generation == generation && !self.paused.load(Ordering::Relaxed) => {
                let since = c.at.elapsed().as_secs_f64() - c.latency.as_secs_f64();
                (c.start + since).clamp(c.floor, c.end)
            }
            // Paused, or nothing played yet since the last seek: the queue head is exact.
            _ => head,
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let position = self.position();
        let meta = self.meta.lock().unwrap();
        Snapshot {
            state: meta.state,
            position,
            duration: meta.duration,
            path: meta.path.clone(),
            volume: self.volume(),
        }
    }

    /// Called from the audio callback.
    fn fill<T>(&self, out: &mut [T], info: &cpal::OutputCallbackInfo)
    where
        T: SizedSample + FromSample<f32>,
    {
        let silence = T::from_sample(0.0f32);
        let ts = info.timestamp();
        let latency = ts.playback.duration_since(ts.callback);
        let at = Instant::now();

        let channels = self.channels;
        let paused = self.paused.load(Ordering::Relaxed);
        let grain_left = self.grain_left.load(Ordering::Relaxed);
        if paused && grain_left == 0 {
            out.fill(silence);
            return;
        }
        // Paused with a grain pending: play only what's left of the grain.
        let limit = if paused {
            out.len().min(grain_left as usize * channels)
        } else {
            out.len()
        };

        let volume = self.volume();
        let rate = self.rate as f64;
        let grain = paused.then(|| {
            let total = self.grain_total.load(Ordering::Relaxed);
            let fade_in = (GRAIN_FADE_IN.as_secs_f64() * rate).max(1.0);
            let fade_out = (GRAIN_FADE_OUT.as_secs_f64() * rate).max(1.0);
            (total, total.saturating_sub(grain_left), fade_in, fade_out)
        });

        let mut q = self.queue.lock().unwrap();
        let start = q.head_pos;
        let mut written = 0;
        while written < limit {
            let Some(chunk) = q.chunks.front_mut() else {
                break;
            };
            let n = (chunk.samples.len() - chunk.read).min(limit - written);
            for (i, (dst, src)) in out[written..written + n]
                .iter_mut()
                .zip(&chunk.samples[chunk.read..chunk.read + n])
                .enumerate()
            {
                let gain = match grain {
                    Some((total, done, fade_in, fade_out)) => {
                        let f = (done + ((written + i) / channels) as u64) as f64;
                        (f / fade_in).min(1.0) * ((total as f64 - f) / fade_out).clamp(0.0, 1.0)
                    }
                    None => 1.0,
                } as f32;
                *dst = T::from_sample(src * volume * gain);
            }
            chunk.read += n;
            written += n;
            if chunk.read == chunk.samples.len() {
                q.chunks.pop_front();
            }
        }
        // Underrun or end of stream: pad with silence, the clock simply doesn't advance.
        out[written..].fill(silence);

        let frames = written / channels;
        if paused {
            self.grain_left
                .store(grain_left.saturating_sub(frames as u64), Ordering::Relaxed);
        }
        q.buffered_frames = q.buffered_frames.saturating_sub(frames);
        q.head_pos += frames as f64 / rate;
        let end = q.head_pos;
        let generation = q.generation;
        drop(q);

        let mut clock = self.clock.lock().unwrap();
        let floor = match *clock {
            Some(c) if c.generation == generation => c.floor,
            _ => start,
        };
        *clock = Some(Clock {
            generation,
            start,
            end,
            floor,
            at,
            latency,
        });
    }
}

/// Opens the default output device. The returned stream must stay on the thread that
/// created it (cpal streams are not `Send` on every platform).
pub(crate) fn open() -> Result<(Stream, Arc<Shared>), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no default output device")?;
    let supported = device
        .default_output_config()
        .map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();

    let shared = Arc::new(Shared::new(
        config.sample_rate as u32,
        config.channels as usize,
    ));

    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, shared.clone()),
        SampleFormat::I16 => build::<i16>(&device, &config, shared.clone()),
        SampleFormat::U16 => build::<u16>(&device, &config, shared.clone()),
        SampleFormat::I32 => build::<i32>(&device, &config, shared.clone()),
        other => return Err(format!("unsupported sample format: {other}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;

    log::info!(
        "output: {} Hz, {} ch, {format}",
        config.sample_rate,
        config.channels
    );
    Ok((stream, shared))
}

fn build<T>(device: &cpal::Device, config: &StreamConfig, shared: Arc<Shared>) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    device
        .build_output_stream(
            config.clone(),
            move |data: &mut [T], info: &cpal::OutputCallbackInfo| shared.fill(data, info),
            |err| log::warn!("output stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}
