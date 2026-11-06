//! IEEE 754 binary16 ("half float") conversion, round to nearest even, for half-float textures (v1 baked the
//! environment map into a `HalfFloatType` target).

/// f32 to binary16 bits, rounding to nearest, ties to even; overflow gives ±∞, NaN stays NaN (quiet).
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]
// every narrowing below is of a value already masked or bounded to 16 bits
pub fn f32_to_f16(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32;
    let mant = bits & 0x007f_ffff;
    if exp == 0xff {
        return sign | 0x7c00 | if mant == 0 { 0 } else { 0x0200 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign; // below half the smallest subnormal: ±0
        }
        let m = mant | 0x0080_0000;
        let shift = (14 - e) as u32;
        let base = m >> shift;
        let rem = m & ((1 << shift) - 1);
        let halfway = 1 << (shift - 1);
        let rounded = if rem > halfway || (rem == halfway && base & 1 == 1) {
            base + 1
        } else {
            base
        };
        return sign | rounded as u16;
    }
    let mut h = ((e as u32) << 10) | (mant >> 13);
    let rem = mant & 0x1fff;
    if rem > 0x1000 || (rem == 0x1000 && h & 1 == 1) {
        h += 1; // a carry into the exponent is the right result (the next binade, or ∞)
    }
    sign | h as u16
}

/// binary16 bits to f32 (exact).
#[must_use]
pub fn f16_to_f32(h: u16) -> f32 {
    let sign = u32::from(h & 0x8000) << 16;
    let exp = u32::from((h >> 10) & 0x1f);
    let mant = u32::from(h & 0x03ff);
    let bits = match exp {
        0 if mant == 0 => sign,
        0 => {
            // subnormal: normalise
            let mut e = 127 - 15 + 1;
            let mut m = mant;
            while m & 0x0400 == 0 {
                m <<= 1;
                e -= 1;
            }
            sign | (e << 23) | ((m & 0x03ff) << 13)
        }
        0x1f => sign | 0x7f80_0000 | (mant << 13),
        _ => sign | ((exp + 127 - 15) << 23) | (mant << 13),
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::*;

    #[test]
    fn every_half_round_trips() {
        // Every value natively; every 251st under Miri, which interprets each.
        for h in (0..=u16::MAX).step_by(if cfg!(miri) { 251 } else { 1 }) {
            let f = f16_to_f32(h);
            if f.is_nan() {
                assert!(f16_to_f32(f32_to_f16(f)).is_nan());
            } else {
                assert_eq!(f32_to_f16(f), h, "{h:#06x} -> {f}");
            }
        }
    }

    #[test]
    fn rounds_to_nearest_even() {
        assert_eq!(f32_to_f16(1.0), 0x3c00);
        assert_eq!(f32_to_f16(65504.0), 0x7bff);
        assert_eq!(f32_to_f16(65520.0), 0x7c00); // halfway to the next: ties to even, which is ∞
        assert_eq!(f32_to_f16(1.0 + 1.0 / 2048.0), 0x3c00); // tie, even stays
        assert_eq!(f32_to_f16(1.0 + 3.0 / 2048.0), 0x3c02); // tie, odd rounds up
        assert_eq!(f32_to_f16(5.960_464_5e-8), 0x0001); // the smallest subnormal
        assert_eq!(f32_to_f16(2.980_232_2e-8), 0x0000); // half of it: ties to even (0)
        assert_eq!(f32_to_f16(-0.0), 0x8000);
        // Monotone and nearest on a sweep.
        let mut prev = 0;
        for i in (0..200_000_u32).step_by(if cfg!(miri) { 997 } else { 1 }) {
            #[allow(clippy::cast_precision_loss)]
            let x = i as f32 * 0.37;
            let h = f32_to_f16(x);
            assert!(h >= prev);
            prev = h;
            if h < 0x7bff {
                let (lo, hi) = (f16_to_f32(h), f16_to_f32(h + 1));
                assert!((x - lo).abs() <= (hi - x).abs() || h == 0);
            }
        }
    }
}
