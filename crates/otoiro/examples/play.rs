//! cargo run -p otoiro --example play -- <file> [seek_seconds]
use std::time::{Duration, Instant};

use otoiro::{Engine, EngineEvent};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: play <file> [seek_seconds]");
    let seek_to: Option<f64> = args.next().and_then(|s| s.parse().ok());

    let engine = Engine::new(|ev| match ev {
        EngineEvent::Snapshot { .. } => {}
        other => println!("event: {other:?}"),
    })
    .expect("engine");

    engine.load(&path, true).unwrap();
    let started = Instant::now();
    let mut seeked = false;
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let s = engine.snapshot();
        println!(
            "wall {:6.2}s | {:?} pos {:6.2}s / {:?}",
            started.elapsed().as_secs_f64(),
            s.state,
            s.position,
            s.duration.map(|d| (d * 100.0).round() / 100.0)
        );
        if let (Some(t), false) = (seek_to, seeked) {
            if started.elapsed() > Duration::from_secs(3) {
                println!("--- seek to {t}s");
                engine.seek(t).unwrap();
                seeked = true;
            }
        }
        if matches!(s.state, otoiro::PlaybackState::Ended | otoiro::PlaybackState::Idle) {
            break;
        }
    }
}
