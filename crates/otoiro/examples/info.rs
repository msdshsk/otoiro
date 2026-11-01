//! cargo run -p otoiro --example info -- <file>
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: info <file>");
    println!("{:#?}", otoiro::media_info(&path));
    if let Ok(Some(cover)) = otoiro::cover_art(&path) {
        println!("cover: {:?}, {} bytes", cover.media_type, cover.data.len());
    }
    let t = Instant::now();
    let w = otoiro::waveform(&path, 1000).expect("waveform");
    let max_rms = w.rms.iter().cloned().fold(0.0f32, f32::max);
    for sec in &w.sections {
        println!("  section {:6.1}s - {:6.1}s  energy {:.2}", sec.start, sec.end, sec.energy);
    }
    if std::env::var_os("OTOIRO_DEBUG").is_some() {
        let per = w.rms.len() as f64 / w.duration;
        let mut t = 0.0;
        while t < w.duration {
            let a = (t * per) as usize;
            let b = (((t + 5.0) * per) as usize).min(w.rms.len());
            let m = w.rms[a..b].iter().map(|r| r * r).sum::<f32>() / (b - a).max(1) as f32;
            println!("  {t:5.0}s {:6.1} dB", 10.0 * (m + 1e-10).log10());
            t += 5.0;
        }
    }
    println!("  highlight: {:?}", w.highlight.map(|h| (h * 10.0).round() / 10.0));
    println!("waveform: {:.2}s, {} buckets, max rms {max_rms:.3}, brightness {:.2}, took {:?}", w.duration, w.peak.len(), w.brightness, t.elapsed());
}
