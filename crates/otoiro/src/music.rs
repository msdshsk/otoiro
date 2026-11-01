//! Song structure from content rather than level:
//!
//! - **Chorus**: the harmonic content (chroma) is compared with itself at every time lag; long
//!   stretches that recur are repetitions (a simplified take on Goto's RefraiD). The chorus is
//!   the repeated part that is loudest and most sung, and every occurrence is reported.
//! - **Vocals**: lead vocals are almost always mixed to the centre, so the voice band
//!   (300–3500 Hz) of the mid signal rising well above the side signal marks singing. The first
//!   sustained stretch is the vocal entry. Needs a stereo source.

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;
use serde::Serialize;

/// Analysis sample rate after decimation; plenty for chroma and the voice band.
const TARGET_RATE: f64 = 11025.0;
const FFT_LEN: usize = 4096;
const HOP: usize = 1024;
/// STFT frames are pooled by this factor for the self-similarity (≈5 frames/s).
const POOL: usize = 2;

const CHROMA_MIN_HZ: f64 = 55.0;
const CHROMA_MAX_HZ: f64 = 2000.0;
const VOICE_MIN_HZ: f64 = 300.0;
const VOICE_MAX_HZ: f64 = 3500.0;

/// Repetitions shorter than this are ignored (a chorus is rarely shorter).
const MIN_REPEAT_SECONDS: f64 = 8.0;
/// Repetitions closer than this are a section repeating itself (e.g. a loop), not a return.
const MIN_LAG_SECONDS: f64 = 6.0;
const DIAGONAL_SMOOTH_SECONDS: f64 = 2.0;
/// Fraction of lag-similarity values treated as "the same music".
const REPEAT_QUANTILE: f64 = 0.85;
const MAX_REPEATS: usize = 48;
/// A "chorus" longer than this is the whole loop repeating (typical of BGM), not a chorus.
const MAX_CHORUS_SECONDS: f64 = 45.0;

const VOCAL_SMOOTH_SECONDS: f64 = 1.5;
const VOCAL_MIN_SECONDS: f64 = 2.5;
const VOCAL_GAP_SECONDS: f64 = 3.0;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Default)]
pub(crate) struct Content {
    /// Start of every chorus occurrence, ascending. Empty when no repetition was found.
    pub choruses: Vec<Span>,
    /// Stretches with (lead) vocals. Empty for mono sources or when nothing stands out.
    pub vocals: Vec<Span>,
}

/// Collects a decimated mid/side signal while the file is being decoded.
pub(crate) struct Downmix {
    mid: Vec<f32>,
    side: Vec<f32>,
    factor: usize,
    acc: (f32, f32, usize),
    rate: f64,
}

impl Downmix {
    pub fn new(sample_rate: u32) -> Self {
        let factor = (sample_rate as f64 / TARGET_RATE).round().max(1.0) as usize;
        Self {
            mid: Vec::new(),
            side: Vec::new(),
            factor,
            acc: (0.0, 0.0, 0),
            rate: sample_rate as f64 / factor as f64,
        }
    }

    /// One interleaved frame. Box-filter decimation is crude but fine below ~4 kHz.
    pub fn push(&mut self, frame: &[f32]) {
        let l = frame[0];
        let r = *frame.get(1).unwrap_or(&l);
        self.acc.0 += (l + r) * 0.5;
        self.acc.1 += (l - r) * 0.5;
        self.acc.2 += 1;
        if self.acc.2 == self.factor {
            let n = self.factor as f32;
            self.mid.push(self.acc.0 / n);
            self.side.push(self.acc.1 / n);
            self.acc = (0.0, 0.0, 0);
        }
    }
}

struct Frames {
    /// Pooled frames per second.
    fps: f64,
    chroma: Vec<[f32; 12]>,
    loud: Vec<f64>,
    /// Voice-band energy, mid and side.
    voice_mid: Vec<f64>,
    voice_side: Vec<f64>,
}

pub(crate) fn analyze(d: &Downmix) -> Content {
    let Some(frames) = stft(d) else {
        return Content::default();
    };
    let vocals = vocals(&frames);
    let choruses = choruses(&frames, &vocals);
    Content { choruses, vocals }
}

fn stft(d: &Downmix) -> Option<Frames> {
    if d.mid.len() < FFT_LEN * 4 {
        return None;
    }
    let n = (d.mid.len() - FFT_LEN) / HOP + 1;
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_LEN);
    let window: Vec<f32> = (0..FFT_LEN)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_LEN as f32).cos())
        .collect();
    let bin_hz = d.rate / FFT_LEN as f64;
    let bin = |hz: f64| ((hz / bin_hz).round() as usize).min(FFT_LEN / 2);
    let pitch_class: Vec<Option<usize>> = (0..=FFT_LEN / 2)
        .map(|k| {
            let f = k as f64 * bin_hz;
            (CHROMA_MIN_HZ..=CHROMA_MAX_HZ)
                .contains(&f)
                .then(|| ((12.0 * (f / 440.0).log2()).round() as i64 + 69).rem_euclid(12) as usize)
        })
        .collect();
    let (v_lo, v_hi) = (bin(VOICE_MIN_HZ), bin(VOICE_MAX_HZ));

    let mut input = fft.make_input_vec();
    let mut spec_m = fft.make_output_vec();
    let mut spec_s = fft.make_output_vec();
    let mut run = |src: &[f32], at: usize, out: &mut Vec<Complex<f32>>| {
        for (i, x) in input.iter_mut().enumerate() {
            *x = src[at + i] * window[i];
        }
        let _ = fft.process(&mut input, out);
    };

    let pooled = n / POOL;
    let mut frames = Frames {
        fps: d.rate / HOP as f64 / POOL as f64,
        chroma: vec![[0.0; 12]; pooled],
        loud: vec![0.0; pooled],
        voice_mid: vec![0.0; pooled],
        voice_side: vec![0.0; pooled],
    };
    for i in 0..pooled * POOL {
        let p = i / POOL;
        let at = i * HOP;
        run(&d.mid, at, &mut spec_m);
        run(&d.side, at, &mut spec_s);
        let mut total = 0.0f64;
        for (k, (m, s)) in spec_m.iter().zip(&spec_s).enumerate() {
            let (pm, ps) = (m.norm_sqr() as f64, s.norm_sqr() as f64);
            total += pm + ps;
            if let Some(pc) = pitch_class[k] {
                frames.chroma[p][pc] += m.norm();
            }
            if (v_lo..=v_hi).contains(&k) {
                frames.voice_mid[p] += pm;
                frames.voice_side[p] += ps;
            }
        }
        frames.loud[p] += total;
    }
    for l in &mut frames.loud {
        *l = 10.0 * (*l + 1e-9).log10();
    }
    Some(frames)
}

/// Centred voice-band activity → stretches with vocals.
fn vocals(f: &Frames) -> Vec<Span> {
    let n = f.loud.len();
    let side_total: f64 = f.voice_side.iter().sum();
    let mid_total: f64 = f.voice_mid.iter().sum();
    // Mono (or near-mono) sources carry no centre/side information.
    if mid_total <= 0.0 || side_total / mid_total < 0.005 {
        return Vec::new();
    }

    // How far the voice band's mid level stands above its side level, in dB, gated by the
    // band actually being loud (silence shouldn't count as "centred").
    let raw: Vec<f64> = (0..n)
        .map(|i| 10.0 * ((f.voice_mid[i] + 1e-9) / (f.voice_side[i] + 1e-9)).log10())
        .collect();
    let score = moving_average(&raw, (VOCAL_SMOOTH_SECONDS * f.fps) as usize);
    let loud_floor = quantile(&f.loud, 0.1);

    let lo = quantile(&score, 0.2);
    let hi = quantile(&score, 0.9);
    // Not enough contrast: either vocals throughout or none at all; don't guess.
    if hi - lo < 2.0 {
        return Vec::new();
    }
    let threshold = lo + 0.4 * (hi - lo);
    let on: Vec<bool> = (0..n)
        .map(|i| score[i] >= threshold && f.loud[i] > loud_floor + 3.0)
        .collect();

    let spans = runs(&on, f.fps, VOCAL_GAP_SECONDS, VOCAL_MIN_SECONDS);
    // Vocals nowhere or nearly everywhere is no information either.
    let covered: f64 = spans.iter().map(|s| s.end - s.start).sum();
    let length = n as f64 / f.fps;
    if spans.is_empty() || covered > 0.95 * length {
        return Vec::new();
    }
    spans
}

/// One repetition: the later segment `[start, end)` repeats the one `lag` frames earlier.
#[derive(Clone, Copy)]
struct Repeat {
    lag: usize,
    start: usize,
    end: usize,
    strength: f64,
}

fn choruses(f: &Frames, vocals: &[Span]) -> Vec<Span> {
    let n = f.chroma.len();
    let fps = f.fps;
    let min_len = (MIN_REPEAT_SECONDS * fps) as usize;
    let min_lag = (MIN_LAG_SECONDS * fps) as usize;
    if n < min_len * 2 + min_lag {
        return Vec::new();
    }

    // Chroma, smoothed over ~1 s, centred on the track mean so similarity reflects what
    // differs between parts rather than the key, then unit length.
    let smooth = (fps).round() as usize;
    let mut chroma = vec![[0.0f32; 12]; n];
    for c in 0..12 {
        let col: Vec<f64> = f.chroma.iter().map(|v| v[c] as f64).collect();
        for (i, v) in moving_average(&col, smooth).into_iter().enumerate() {
            chroma[i][c] = v as f32;
        }
    }
    let mut mean = [0.0f32; 12];
    for v in &chroma {
        for c in 0..12 {
            mean[c] += v[c] / n as f32;
        }
    }
    for v in &mut chroma {
        let mut norm = 0.0f32;
        for c in 0..12 {
            v[c] -= mean[c];
            norm += v[c] * v[c];
        }
        let norm = norm.sqrt();
        if norm > 1e-6 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
    }
    let sim = |a: usize, b: usize| -> f64 {
        chroma[a].iter().zip(&chroma[b]).map(|(x, y)| (x * y) as f64).sum()
    };

    // Similarity along every lag, smoothed so a repeat reads as a plateau.
    let diag_smooth = (DIAGONAL_SMOOTH_SECONDS * fps) as usize;
    let diagonals: Vec<(usize, Vec<f64>)> = (min_lag..n - min_len)
        .map(|lag| {
            let raw: Vec<f64> = (lag..n).map(|t| sim(t, t - lag)).collect();
            (lag, moving_average(&raw, diag_smooth))
        })
        .collect();
    let mut sample: Vec<f64> = diagonals
        .iter()
        .flat_map(|(_, d)| d.iter().step_by(3).copied())
        .collect();
    if sample.is_empty() {
        return Vec::new();
    }
    let threshold = quantile_mut(&mut sample, REPEAT_QUANTILE).max(0.3);

    let mut repeats: Vec<Repeat> = Vec::new();
    for (lag, d) in &diagonals {
        let mut t = 0;
        while t < d.len() {
            if d[t] < threshold {
                t += 1;
                continue;
            }
            let s = t;
            while t < d.len() && d[t] >= threshold {
                t += 1;
            }
            if t - s >= min_len {
                let mean = d[s..t].iter().sum::<f64>() / (t - s) as f64;
                repeats.push(Repeat {
                    lag: *lag,
                    start: s + lag,
                    end: t + lag,
                    strength: mean * (t - s) as f64,
                });
            }
        }
    }

    // Neighbouring lags see the same repetition; keep the strongest of each.
    repeats.sort_by(|a, b| b.strength.total_cmp(&a.strength));
    let lag_tol = (2.0 * fps) as usize;
    let mut kept: Vec<Repeat> = Vec::new();
    for r in repeats {
        let duplicate = kept.iter().any(|k| {
            k.lag.abs_diff(r.lag) <= lag_tol && overlap(k.start, k.end, r.start, r.end) > 0.5
        });
        if !duplicate {
            kept.push(r);
            if kept.len() == MAX_REPEATS {
                break;
            }
        }
    }
    if kept.is_empty() {
        return Vec::new();
    }

    // Per-frame evidence: how loud, how sung.
    let loud = moving_average(&f.loud, (2.0 * fps) as usize);
    let (l_lo, l_hi) = (quantile(&loud, 0.05), quantile(&loud, 0.95));
    let loud_norm = |i: usize| ((loud[i] - l_lo) / (l_hi - l_lo).max(1e-6)).clamp(0.0, 1.0);
    let sung = |i: usize| {
        let t = i as f64 / fps;
        vocals.iter().any(|v| v.start <= t && t < v.end) as u8 as f64
    };
    let has_vocals = !vocals.is_empty();

    // Score each repeated segment (both sides of every repeat); the chorus is the repeated
    // material that is loud and sung, and recurs.
    let mut segments: Vec<(usize, usize)> = Vec::new();
    for r in &kept {
        segments.push((r.start - r.lag, r.end - r.lag));
        segments.push((r.start, r.end));
    }
    let score = |&(a, b): &(usize, usize)| {
        let len = (b - a) as f64;
        let loud = (a..b).map(loud_norm).sum::<f64>() / len;
        let sung = if has_vocals { (a..b).map(sung).sum::<f64>() / len } else { 0.0 };
        let recurrences = segments.iter().filter(|s| overlap(s.0, s.1, a, b) > 0.5).count() as f64;
        loud + 0.5 * sung + 0.25 * recurrences.ln()
    };
    let best = *segments
        .iter()
        .max_by(|x, y| score(x).total_cmp(&score(y)))
        .expect("non-empty");

    // Every occurrence of that material: segments that overlap it, and their repeat partners.
    let mut occurrences: Vec<(usize, usize)> = vec![best];
    for r in &kept {
        let earlier = (r.start - r.lag, r.end - r.lag);
        let later = (r.start, r.end);
        if overlap(earlier.0, earlier.1, best.0, best.1) > 0.5 {
            occurrences.push(later);
        }
        if overlap(later.0, later.1, best.0, best.1) > 0.5 {
            occurrences.push(earlier);
        }
    }
    occurrences.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    let join = (4.0 * fps) as usize;
    for o in occurrences {
        match merged.last_mut() {
            Some(m) if o.0 <= m.1 && o.0 < m.0 + join.max(1) => m.1 = m.1.max(o.1),
            Some(m) if o.0 < m.1 => m.1 = m.1.max(o.1),
            _ => merged.push(o),
        }
    }

    // Choruses that typically run longer than MAX_CHORUS_SECONDS are a loop repeating as a
    // whole (common in BGM). One long final chorus (often doubled) is fine.
    let mut lengths: Vec<f64> = merged.iter().map(|m| (m.1 - m.0) as f64 / fps).collect();
    if quantile_mut(&mut lengths, 0.5) > MAX_CHORUS_SECONDS {
        return Vec::new();
    }

    // A repeat found via smoothing starts a little late or early; snap each start to the
    // strongest level rise nearby, which is usually where the chorus kicks in.
    let reach = (2.0 * fps) as usize;
    let w = ((0.6 * fps) as usize).max(1);
    let rise = |t: usize| {
        let a = f.loud[t.saturating_sub(w)..t].iter().sum::<f64>() / w as f64;
        let b = f.loud[t..(t + w).min(n)].iter().sum::<f64>() / w as f64;
        b - a
    };
    merged
        .into_iter()
        .map(|(a, b)| {
            let lo = a.saturating_sub(reach).max(w);
            let hi = (a + reach).min(n.saturating_sub(w + 1));
            let start = (lo..=hi).max_by(|&x, &y| rise(x).total_cmp(&rise(y))).unwrap_or(a);
            Span {
                start: start as f64 / fps,
                end: b as f64 / fps,
            }
        })
        .collect()
}

/// Fraction of the shorter range covered by the intersection.
fn overlap(a0: usize, a1: usize, b0: usize, b1: usize) -> f64 {
    let inter = a1.min(b1).saturating_sub(a0.max(b0)) as f64;
    let shorter = (a1 - a0).min(b1 - b0).max(1) as f64;
    inter / shorter
}

/// Boolean frames → spans, bridging short gaps and dropping short blips.
fn runs(on: &[bool], fps: f64, max_gap: f64, min_len: f64) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    let mut i = 0;
    while i < on.len() {
        if !on[i] {
            i += 1;
            continue;
        }
        let s = i;
        while i < on.len() && on[i] {
            i += 1;
        }
        let span = Span {
            start: s as f64 / fps,
            end: i as f64 / fps,
        };
        match spans.last_mut() {
            Some(last) if span.start - last.end <= max_gap => last.end = span.end,
            _ => spans.push(span),
        }
    }
    spans.retain(|s| s.end - s.start >= min_len);
    spans
}

fn quantile(v: &[f64], q: f64) -> f64 {
    let mut sorted = v.to_vec();
    quantile_mut(&mut sorted, q)
}

fn quantile_mut(v: &mut [f64], q: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let k = ((v.len() - 1) as f64 * q).round() as usize;
    *v.select_nth_unstable_by(k, |a, b| a.total_cmp(b)).1
}

fn moving_average(v: &[f64], window: usize) -> Vec<f64> {
    let half = window.max(1) / 2;
    let mut prefix = Vec::with_capacity(v.len() + 1);
    prefix.push(0.0);
    for x in v {
        prefix.push(prefix.last().unwrap() + x);
    }
    (0..v.len())
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(v.len());
            (prefix[b] - prefix[a]) / (b - a) as f64
        })
        .collect()
}
