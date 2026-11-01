//! cargo run -p otoiro --example scrub -- <file> [start_seconds]
//! Scrubs forward in 1/30 s steps at 30 steps per second, like turning a jog wheel.
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: scrub <file> [start_seconds]");
    let start: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(10.0);

    let engine = otoiro::Engine::new(|_| {}).expect("engine");
    engine.load(&path, false).unwrap();
    std::thread::sleep(Duration::from_millis(300));

    for i in 0..60 {
        let target = start + i as f64 / 30.0;
        engine.scrub(target).unwrap();
        std::thread::sleep(Duration::from_millis(33));
        if i % 10 == 0 {
            let s = engine.snapshot();
            println!("step {i:2}: target {target:6.3}s  pos {:6.3}s  {:?}", s.position, s.state);
        }
    }
    std::thread::sleep(Duration::from_millis(200));
    let s = engine.snapshot();
    println!("after: pos {:6.3}s {:?}", s.position, s.state);
}
