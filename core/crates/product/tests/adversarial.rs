//! Linear time on the inputs that held v1 (contract §2.11 "no page can hold the server: size patterns run in linear
//! time"): each adversarial line is read at n and 8n characters, and the larger must not take more than ~8 times as
//! long (a quadratic reader would take 64 times). The page that once froze v1 (a 12,000-digit run and 20,000 escaped
//! quotes) is in E14; these go further, to 800,000 characters per line.
//!
//! Timing is measured, so it is only run on purpose: `cargo test -p midstudy-product --release --test adversarial -- --ignored`.
use midstudy_product::Ctx;
use midstudy_product::api;
use std::fmt::Write as _;
use std::time::Instant;

fn lines_of(unit: &str, n: usize) -> String {
    unit.repeat(n.div_ceil(unit.len().max(1)))
}

/// Seconds for each reader over one line of text.
fn read_each(text: &str) -> Vec<(&'static str, f64)> {
    let mut out = Vec::new();
    let mut time = |name: &'static str, f: &dyn Fn()| {
        let t0 = Instant::now();
        f();
        out.push((name, t0.elapsed().as_secs_f64()));
    };
    time("has_size", &|| {
        let _ = api::has_size(text);
    });
    time("text_readings", &|| {
        let _ = api::text_readings(
            text,
            Ctx {
                is_rug: true,
                hint: Some(midstudy_product::Unit::Cm),
                is_bed: false,
            },
        );
    });
    time("unit_hint", &|| {
        let _ = api::unit_hint(text);
    });
    time("thickness", &|| {
        let _ = api::thickness(text, None);
    });
    time("quote_numbers", &|| {
        let _ = api::quote_numbers(text);
    });
    time("llm_text", &|| {
        let _ = api::llm_text(text);
    });
    time("category_of", &|| {
        let _ = api::category_of(text);
    });
    time("words", &|| {
        for kind in ["distract", "intro", "size_words", "robot"] {
            let _ = api::matches(kind, text);
        }
    });
    out
}

const ADVERSARIAL: [&str; 14] = [
    "1",                         // one long digit run (v1's freeze)
    "1 ",                        // a number on every other character
    "1x",                        // sizes chained without end
    "W ",                        // labels without numbers
    "W 1 ",                      // labels and numbers
    "overall   ",                // a label word followed by long space runs
    "( W x D x ( W x ",          // order keys that never close
    "1.1.1.1,",                  // decimals without end
    "1 1/1 1/",                  // fractions without end
    "1' 1' 1\" ",                // feet without inches
    "pile height 1 ",            // thickness keys
    "dimension ",                // the size word
    "<page <page ",              // markers to neutralize
    "1\u{a0}\u{a0}\u{a0}\u{bd}", // spaces before a fraction
];

#[test]
#[ignore = "timing: run on purpose with --release --ignored"]
fn linear_on_adversarial_lines() {
    let mut worst: f64 = 0.0;
    for unit in ADVERSARIAL {
        let small = lines_of(unit, 100_000);
        let large = lines_of(unit, 800_000);
        let _ = read_each(&small); // warm the lazily built patterns
        let a = read_each(&small);
        let b = read_each(&large);
        let total: f64 = b.iter().map(|x| x.1).sum();
        let mut line = format!("{unit:?}: 800k in {:.0} ms;", total * 1e3);
        for ((name, ts), (_, tl)) in a.iter().zip(&b) {
            let ratio = tl / ts.max(2e-4);
            if *tl > 2e-3 {
                let _ = write!(line, " {name} {:.0} ms ({ratio:.1}x)", tl * 1e3);
            }
            if *tl > 5e-3 {
                worst = worst.max(ratio);
            }
        }
        println!("{line}");
        assert!(
            total < 3.0,
            "{unit:?}: 800,000 characters took {total:.2} s"
        );
    }
    println!(
        "worst ratio for 8x the input (readers over 5 ms): {worst:.1} (linear 8, quadratic 64)"
    );
    assert!(
        worst < 20.0,
        "a reader grows faster than linearly: {worst:.1}x for 8x the input"
    );
}
