//! Whole-file amplitude overview for drawing a waveform timeline.

use serde::Serialize;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::TrackType;

use crate::info::open_format;
use crate::structure::{self, Section};

/// Analysis resolution before reduction to the requested bucket count.
const BLOCKS_PER_SECOND: u32 = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    /// Seconds covered by the buckets (the decoded length, which is exact).
    pub duration: f64,
    /// Per bucket, 0..=1: the loudest sample.
    pub peak: Vec<f32>,
    /// Per bucket, 0..=1: RMS level, which reads as perceived loudness.
    pub rms: Vec<f32>,
    /// 0..=1, how "bright" the track sounds overall (zero-crossing rate on a log scale).
    /// Useful for picking a colour when there is no cover art.
    pub brightness: f32,
    /// Estimated sections (intro, verse, chorus, ...), split where the loudness contour
    /// changes for good. Always covers the whole track.
    pub sections: Vec<Section>,
    /// Start (seconds) of the section that is most likely the chorus / climax.
    pub highlight: Option<f64>,
}

pub fn waveform(path: &str, buckets: usize) -> Result<Waveform, String> {
    let buckets = buckets.clamp(1, 1 << 16);
    let mut format = open_format(path)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("missing audio codec parameters")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    // Fine blocks first (the total length isn't always known up front), reduced at the end.
    let mut block_peak: Vec<f32> = Vec::new();
    let mut block_sq: Vec<f64> = Vec::new();
    let mut block_len: Vec<u32> = Vec::new();
    let mut block_zc: Vec<u32> = Vec::new();
    let (mut cur_peak, mut cur_sq, mut cur_len, mut cur_zc) = (0f32, 0f64, 0u32, 0u32);
    let mut block_frames = 0u32;
    let mut total_frames = 0u64;
    let mut rate = 0u32;
    let mut samples: Vec<f32> = Vec::new();
    let mut crossings = 0u64;
    let mut last_sign = false;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) | Err(SymError::ResetRequired) => break,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id != track_id {
            continue;
        }
        let channels = match decoder.decode(&packet) {
            Ok(buf) => {
                if rate == 0 {
                    rate = buf.spec().rate();
                    block_frames = (rate / BLOCKS_PER_SECOND).max(1);
                }
                buf.copy_to_vec_interleaved(&mut samples);
                buf.spec().channels().count().max(1)
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };

        for frame in samples.chunks_exact(channels) {
            let sign = frame[0] >= 0.0;
            let crossed = (sign != last_sign) as u32;
            crossings += crossed as u64;
            cur_zc += crossed;
            last_sign = sign;
            let mut sq = 0f64;
            for &s in frame {
                cur_peak = cur_peak.max(s.abs());
                sq += (s as f64) * (s as f64);
            }
            cur_sq += sq / channels as f64;
            cur_len += 1;
            if cur_len == block_frames {
                block_peak.push(cur_peak);
                block_sq.push(cur_sq);
                block_len.push(cur_len);
                block_zc.push(cur_zc);
                (cur_peak, cur_sq, cur_len, cur_zc) = (0.0, 0.0, 0, 0);
            }
        }
        total_frames += (samples.len() / channels) as u64;
    }
    if cur_len > 0 {
        block_peak.push(cur_peak);
        block_sq.push(cur_sq);
        block_len.push(cur_len);
        block_zc.push(cur_zc);
    }

    let mut peak = vec![0f32; buckets];
    let mut rms = vec![0f32; buckets];
    let n = block_peak.len();
    if n > 0 {
        for b in 0..buckets {
            let start = b * n / buckets;
            let end = ((b + 1) * n / buckets).max(start + 1).min(n);
            let (mut p, mut sq, mut len) = (0f32, 0f64, 0u64);
            for i in start..end {
                p = p.max(block_peak[i]);
                sq += block_sq[i];
                len += block_len[i] as u64;
            }
            peak[b] = p.min(1.0);
            rms[b] = ((sq / len.max(1) as f64).sqrt() as f32).min(1.0);
        }
    }

    let duration = if rate > 0 { total_frames as f64 / rate as f64 } else { 0.0 };
    // Two crossings per cycle; map 100 Hz..4 kHz onto 0..1 logarithmically.
    let crossing_hz = if duration > 0.0 { crossings as f64 / duration / 2.0 } else { 0.0 };
    let brightness = ((crossing_hz.max(1.0) / 100.0).log2() / (4000.0f64 / 100.0).log2()).clamp(0.0, 1.0) as f32;

    let block_seconds = if rate > 0 { block_frames as f64 / rate as f64 } else { 0.0 };
    let (sections, highlight) =
        structure::analyze(&block_sq, &block_len, &block_zc, block_seconds, duration);

    Ok(Waveform {
        duration,
        peak,
        rms,
        brightness,
        sections,
        highlight,
    })
}
