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
    println!("waveform: {:.2}s, {} buckets, max rms {max_rms:.3}, brightness {:.2}, took {:?}", w.duration, w.peak.len(), w.brightness, t.elapsed());
}
