//! Decoding side: demux + decode (symphonia), resample (rubato), map channels.
//! Produces interleaved f32 already in the output device's format.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::units::{Time, TimeBase};

use crate::info::{open_format, track_duration};

const RESAMPLER_CHUNK: usize = 1024;

pub(crate) struct Source {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,

    pub duration: Option<f64>,
    pub sample_rate: u32,
    pub channels: usize,

    out_rate: u32,
    out_channels: usize,
    resampler: Option<Fft<f32>>,
    /// Source-rate interleaved samples waiting for a full resampler chunk.
    pending: Vec<f32>,
    resampled: Vec<f32>,
    decoded: Vec<f32>,
    /// Output frames to drop after a reset (the resampler's group delay).
    skip_out: usize,
    /// Input frames fed / output frames emitted since the last reset, used to cut the
    /// zero-padded tail at end of stream.
    fed_in: u64,
    emitted_out: u64,
    /// After a seek, drop decoded frames that lie before this position.
    seek_target: Option<f64>,
    eof: bool,
}

impl Source {
    pub fn open(path: &str, out_rate: u32, out_channels: usize) -> Result<Self, String> {
        let format = open_format(path)?;

        let track = format
            .default_track(TrackType::Audio)
            .ok_or("no audio track")?;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|p| p.audio())
            .ok_or("missing audio codec parameters")?;

        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &AudioDecoderOptions::default())
            .map_err(|e| format!("unsupported codec: {e}"))?;

        let sample_rate = params.sample_rate.unwrap_or(out_rate);
        let channels = params.channels.as_ref().map(|c| c.count()).unwrap_or(2);
        let time_base = track.time_base;

        let track_id = track.id;
        let duration = track_duration(format.as_ref());
        let mut source = Self {
            format,
            decoder,
            track_id,
            time_base,
            duration,
            sample_rate,
            channels,
            out_rate,
            out_channels,
            resampler: None,
            pending: Vec::new(),
            resampled: Vec::new(),
            decoded: Vec::new(),
            skip_out: 0,
            fed_in: 0,
            emitted_out: 0,
            seek_target: None,
            eof: false,
        };
        source.configure(sample_rate, channels)?;
        Ok(source)
    }

    pub fn is_eof(&self) -> bool {
        self.eof
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), String> {
        let time = Time::try_from_secs_f64(seconds).ok_or("invalid seek time")?;
        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|e| format!("seek failed: {e}"))?;
        self.decoder.reset();
        self.reset_resampler();
        self.seek_target = Some(seconds);
        self.eof = false;
        Ok(())
    }

    /// Decodes until at least one output chunk is produced. `Ok(None)` means end of stream.
    pub fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        if self.eof {
            return Ok(None);
        }
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                // End of stream. ResetRequired (chained streams) is treated as the end for now.
                Ok(None) | Err(SymError::ResetRequired) => return Ok(self.finish()),
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(self.finish());
                }
                Err(e) => return Err(e.to_string()),
            };
            if packet.track_id != self.track_id {
                continue;
            }

            let (rate, channels, frames) = match self.decoder.decode(&packet) {
                Ok(buf) => {
                    buf.copy_to_vec_interleaved(&mut self.decoded);
                    (buf.spec().rate(), buf.spec().channels().count(), buf.frames())
                }
                Err(SymError::DecodeError(e)) => {
                    log::debug!("skipping undecodable packet: {e}");
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            if frames == 0 {
                continue;
            }
            // Some codecs (e.g. HE-AAC) only reveal the real format once decoding starts.
            if rate != self.sample_rate || channels != self.channels {
                self.configure(rate, channels)?;
            }

            let mut skip = 0;
            if let Some(target) = self.seek_target {
                let tb = self
                    .time_base
                    .or_else(|| TimeBase::try_from_recip(rate))
                    .ok_or("no time base")?;
                let pkt_start = tb.calc_time_saturating(packet.pts).as_secs_f64();
                skip = (((target - pkt_start) * rate as f64).round().max(0.0) as usize).min(frames);
                if skip < frames {
                    self.seek_target = None;
                }
            }
            let samples = std::mem::take(&mut self.decoded);
            let out = self.process(&samples[skip * channels..frames * channels], false)?;
            self.decoded = samples;

            if !out.is_empty() {
                return Ok(Some(out));
            }
        }
    }

    fn finish(&mut self) -> Option<Vec<f32>> {
        self.eof = true;
        match self.process(&[], true) {
            Ok(out) if !out.is_empty() => Some(out),
            _ => None,
        }
    }

    fn configure(&mut self, rate: u32, channels: usize) -> Result<(), String> {
        self.sample_rate = rate;
        self.channels = channels;
        self.resampler = if rate == self.out_rate {
            None
        } else {
            Some(
                Fft::<f32>::new(
                    rate as usize,
                    self.out_rate as usize,
                    RESAMPLER_CHUNK,
                    channels,
                    FixedSync::Input,
                )
                .map_err(|e| format!("resampler: {e}"))?,
            )
        };
        self.reset_resampler();
        Ok(())
    }

    fn reset_resampler(&mut self) {
        self.pending.clear();
        self.fed_in = 0;
        self.emitted_out = 0;
        self.skip_out = match self.resampler.as_mut() {
            Some(r) => {
                r.reset();
                r.output_delay()
            }
            None => 0,
        };
    }

    /// Resamples (if needed) and maps channels. With `flush`, drains the resampler.
    fn process(&mut self, input: &[f32], flush: bool) -> Result<Vec<f32>, String> {
        let ch = self.channels;
        let mut out = Vec::new();

        let Some(resampler) = self.resampler.as_mut() else {
            map_channels(input, ch, self.out_channels, &mut out);
            return Ok(out);
        };

        self.pending.extend_from_slice(input);
        self.fed_in += (input.len() / ch) as u64;
        if flush {
            // Push enough silence through to get the delayed tail out; the excess is cut below.
            let pad = resampler.input_frames_next() + resampler.output_delay() + 1;
            self.pending.resize(self.pending.len() + pad * ch, 0.0);
        }

        let ratio = self.out_rate as f64 / self.sample_rate as f64;
        let mut resampled_all = Vec::new();
        loop {
            let need = resampler.input_frames_next();
            let have = self.pending.len() / ch;
            if have < need {
                break;
            }
            let out_frames = resampler.output_frames_next();
            self.resampled.resize(out_frames * ch, 0.0);
            let input = InterleavedSlice::new(&self.pending[..], ch, have).map_err(|e| format!("{e:?}"))?;
            let mut output = InterleavedSlice::new_mut(&mut self.resampled[..], ch, out_frames)
                .map_err(|e| format!("{e:?}"))?;
            let indexing = Indexing {
                input_offset: 0,
                output_offset: 0,
                partial_len: None,
                active_channels_mask: None,
            };
            let (consumed, produced) = resampler
                .process_into_buffer(&input, &mut output, Some(&indexing))
                .map_err(|e| format!("resample: {e}"))?;
            self.pending.drain(..consumed * ch);

            let skip = self.skip_out.min(produced);
            self.skip_out -= skip;
            let mut frames = produced - skip;
            if flush {
                let expected = (self.fed_in as f64 * ratio).round() as u64;
                frames = frames.min(expected.saturating_sub(self.emitted_out) as usize);
            }
            self.emitted_out += frames as u64;
            resampled_all.extend_from_slice(&self.resampled[skip * ch..(skip + frames) * ch]);
        }
        if flush {
            self.pending.clear();
        }

        map_channels(&resampled_all, ch, self.out_channels, &mut out);
        Ok(out)
    }
}

/// Mono is duplicated to every output channel; otherwise channels are copied by index and
/// extra source channels are dropped. (A proper downmix matrix can come later.)
fn map_channels(input: &[f32], src: usize, dst: usize, out: &mut Vec<f32>) {
    if src == dst {
        out.extend_from_slice(input);
        return;
    }
    out.reserve(input.len() / src * dst);
    for frame in input.chunks_exact(src) {
        for c in 0..dst {
            out.push(frame[c.min(src - 1)]);
        }
    }
}
