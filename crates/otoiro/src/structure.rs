//! Rough song structure from the loudness contour: where sections change, and which one is
//! the climax. Not a musicological analysis — it looks for sustained level changes, which is
//! enough to jump straight to "the big part" when auditioning background music.

use serde::Serialize;

/// Analysis frame rate (frames per second) for the contour.
const FRAME_RATE: f64 = 10.0;
/// Loudness is smoothed over this window before looking for changes.
const SMOOTH_SECONDS: f64 = 1.0;
/// A boundary compares this much audio before and after it.
const NOVELTY_WINDOW_SECONDS: f64 = 4.0;
/// Minimum level change (dB) for a boundary.
const MIN_CHANGE_DB: f64 = 2.5;
/// Sections shorter than this are not created.
const MIN_SECTION_SECONDS: f64 = 8.0;
const MAX_BOUNDARIES: usize = 12;
/// Boundaries are moved to the sharpest level change within this distance.
const REFINE_SECONDS: f64 = 1.5;
/// Fallback climax window when no boundaries are found.
const FALLBACK_WINDOW_SECONDS: f64 = 12.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub start: f64,
    pub end: f64,
    /// 0..=1 relative intensity within the track (loudest section = 1).
    pub energy: f32,
}

/// `block_*` are per analysis block of `block_seconds`: summed per-frame mean squares, frame
/// counts and zero crossings.
pub(crate) fn analyze(
    block_sq: &[f64],
    block_len: &[u32],
    block_zc: &[u32],
    block_seconds: f64,
    duration: f64,
) -> (Vec<Section>, Option<f64>) {
    if block_sq.is_empty() || block_seconds <= 0.0 || duration <= 0.0 {
        return (Vec::new(), None);
    }

    // 1. Contour at FRAME_RATE: loudness (dB) and zero-crossing rate (brightness/density).
    let per_frame = ((1.0 / FRAME_RATE) / block_seconds).round().max(1.0) as usize;
    let mut loud = Vec::new();
    let mut zcr = Vec::new();
    for ((sq, len), zc) in block_sq
        .chunks(per_frame)
        .zip(block_len.chunks(per_frame))
        .zip(block_zc.chunks(per_frame))
    {
        let frames: u64 = len.iter().map(|&l| l as u64).sum();
        let mean_sq = sq.iter().sum::<f64>() / frames.max(1) as f64;
        loud.push(10.0 * (mean_sq + 1e-10).log10());
        zcr.push(zc.iter().map(|&z| z as f64).sum::<f64>() / frames.max(1) as f64);
    }
    let n = loud.len();
    let secs = |i: usize| (i as f64 / FRAME_RATE).min(duration);

    let smooth = moving_average(&loud, (SMOOTH_SECONDS * FRAME_RATE) as usize);
    let sharp = moving_average(&loud, 3);

    // 2. Novelty: level after minus level before, over a few seconds each side.
    let w = (NOVELTY_WINDOW_SECONDS * FRAME_RATE) as usize;
    let prefix = prefix_sums(&smooth);
    let mean = |a: usize, b: usize| (prefix[b] - prefix[a]) / (b - a).max(1) as f64;
    let mut novelty = vec![0.0; n];
    for i in w..n.saturating_sub(w) {
        novelty[i] = mean(i, i + w) - mean(i - w, i);
    }

    // 3. Strongest local peaks of |novelty|, spaced out.
    let min_gap = (MIN_SECTION_SECONDS * FRAME_RATE) as usize;
    let mut candidates: Vec<usize> = (1..n.saturating_sub(1))
        .filter(|&i| {
            let v = novelty[i].abs();
            v >= MIN_CHANGE_DB && v >= novelty[i - 1].abs() && v >= novelty[i + 1].abs()
        })
        .collect();
    candidates.sort_by(|&a, &b| novelty[b].abs().total_cmp(&novelty[a].abs()));
    let mut chosen: Vec<usize> = Vec::new();
    for c in candidates {
        let clear_of_edges = c >= min_gap / 2 && c + min_gap / 2 <= n;
        if clear_of_edges && chosen.iter().all(|&b| b.abs_diff(c) >= min_gap) {
            chosen.push(c);
            if chosen.len() == MAX_BOUNDARIES {
                break;
            }
        }
    }

    // 4. Snap each boundary to the sharpest change in the same direction nearby.
    let reach = (REFINE_SECONDS * FRAME_RATE) as usize;
    let mut boundaries: Vec<usize> = chosen
        .iter()
        .map(|&c| {
            let dir = novelty[c].signum();
            let lo = c.saturating_sub(reach).max(2);
            let hi = (c + reach).min(n.saturating_sub(3));
            (lo..=hi)
                .max_by(|&a, &b| {
                    let da = (sharp[a + 2] - sharp[a - 2]) * dir;
                    let db = (sharp[b + 2] - sharp[b - 2]) * dir;
                    da.total_cmp(&db)
                })
                .unwrap_or(c)
        })
        .collect();
    boundaries.sort_unstable();
    boundaries.dedup();

    // 5. Sections and their intensity. Busier (brighter) passages read as fuller, so the
    //    zero-crossing rate nudges the score; very short sections are discounted.
    let track_zcr = zcr.iter().sum::<f64>() / n.max(1) as f64;
    let mut edges = vec![0];
    edges.extend(boundaries.iter().copied());
    edges.push(n);
    let scored: Vec<(usize, usize, f64)> = edges
        .windows(2)
        .filter(|e| e[1] > e[0])
        .map(|e| {
            let (a, b) = (e[0], e[1]);
            let level = loud[a..b].iter().sum::<f64>() / (b - a) as f64;
            let z = zcr[a..b].iter().sum::<f64>() / (b - a) as f64;
            let density = if track_zcr > 0.0 && z > 0.0 {
                3.0 * (z / track_zcr).log2()
            } else {
                0.0
            };
            let short = if ((b - a) as f64) < MIN_SECTION_SECONDS * FRAME_RATE { 3.0 } else { 0.0 };
            (a, b, level + density - short)
        })
        .collect();

    let (lo, hi) = scored
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), s| (lo.min(s.2), hi.max(s.2)));
    let sections: Vec<Section> = scored
        .iter()
        .map(|&(a, b, score)| Section {
            start: secs(a),
            end: if b == n { duration } else { secs(b) },
            energy: if hi > lo { ((score - lo) / (hi - lo)) as f32 } else { 1.0 },
        })
        .collect();

    let highlight = if sections.len() > 1 {
        scored
            .iter()
            .max_by(|a, b| a.2.total_cmp(&b.2))
            .map(|&(a, _, _)| secs(a))
    } else {
        // One flat section: take the loudest stretch instead.
        let win = ((FALLBACK_WINDOW_SECONDS * FRAME_RATE) as usize).min(n);
        let p = prefix_sums(&loud);
        (0..=n - win)
            .max_by(|&a, &b| (p[a + win] - p[a]).total_cmp(&(p[b + win] - p[b])))
            .map(secs)
    };

    (sections, highlight)
}

fn prefix_sums(v: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(v.len() + 1);
    out.push(0.0);
    for x in v {
        out.push(out.last().unwrap() + x);
    }
    out
}

fn moving_average(v: &[f64], window: usize) -> Vec<f64> {
    let half = window.max(1) / 2;
    let p = prefix_sums(v);
    (0..v.len())
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(v.len());
            (p[b] - p[a]) / (b - a) as f64
        })
        .collect()
}
