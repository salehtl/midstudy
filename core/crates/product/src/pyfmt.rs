//! Python's number formatting as v1 used it: `_fmt` (`str(int(round(v)))` or `f"{v:g}"`) and `round(x, n)`.

/// Python's `round(x, n)` on a float: the nearest multiple of 10^-n, ties to even, decided on the exact binary value.
pub(crate) fn py_round(x: f64, n: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let near = format!("{x:.n$}");
    // A tie is only possible when x has at most n + 1 fractional decimal digits; 40 more digits show it exactly.
    let wide = n.saturating_add(40);
    let exact = format!("{x:.wide$}");
    let Some(dot) = exact.find('.') else {
        return near.parse().unwrap_or(x);
    };
    let keep = dot.saturating_add(1).saturating_add(n);
    let (head, tail) = (
        exact.get(..keep).unwrap_or(&exact),
        exact.get(keep..).unwrap_or(""),
    );
    let tie = tail.starts_with('5') && tail.chars().skip(1).all(|c| c == '0');
    if !tie {
        return near.parse().unwrap_or(x);
    }
    let head = head.trim_end_matches('.');
    let last_even = head
        .chars()
        .last()
        .and_then(|c| c.to_digit(10))
        .is_some_and(|d| d % 2 == 0);
    let down: f64 = head.parse().unwrap_or(x);
    if last_even {
        return down;
    }
    let step = 10f64.powi(i32::try_from(n).unwrap_or(0)).recip();
    let away = if x < 0.0 { down - step } else { down + step };
    format!("{away:.n$}").parse().unwrap_or(away)
}

/// Python's `f"{x:g}"` (precision 6).
fn format_g(x: f64) -> String {
    if x.is_nan() {
        return "nan".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "inf".to_owned()
        } else {
            "-inf".to_owned()
        };
    }
    if x == 0.0 {
        return if x.is_sign_negative() {
            "-0".to_owned()
        } else {
            "0".to_owned()
        };
    }
    let sci = format!("{x:.5e}");
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if (-4..6).contains(&exp) {
        let prec = usize::try_from(5i32.saturating_sub(exp)).unwrap_or(0);
        let fixed = format!("{x:.prec$}");
        if fixed.contains('.') {
            fixed.trim_end_matches('0').trim_end_matches('.').to_owned()
        } else {
            fixed
        }
    } else {
        let mant = if mant.contains('.') {
            mant.trim_end_matches('0').trim_end_matches('.')
        } else {
            mant
        };
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{mant}e{sign}{:02}", exp.unsigned_abs())
    }
}

/// v1's `_fmt`: an integral value without a point (`80`), else `{v:g}` (`80.5`, `0.333333`).
pub(crate) fn fmt_num(v: f64) -> String {
    let r = v.round_ties_even();
    if (v - r).abs() < 1e-9 {
        if r == 0.0 {
            "0".to_owned()
        } else {
            format!("{r:.0}")
        }
    } else {
        format_g(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::float_cmp)] // bit-equality with Python's results is the point
    fn rounds_like_python() {
        assert_eq!(py_round(0.25, 1), 0.2);
        assert_eq!(py_round(0.35, 1), 0.3);
        assert_eq!(py_round(0.75, 1), 0.8);
        assert_eq!(py_round(2.675, 2), 2.67);
        assert_eq!(py_round(-0.25, 1), -0.2);
        assert_eq!(py_round(2.5, 0), 2.0);
        assert_eq!(py_round(3.5, 0), 4.0);
        assert_eq!(py_round(152.4 + 1e-9, 1), 152.4);
        assert_eq!(py_round(0.000_209, 6), 0.000_209);
    }

    #[test]
    fn formats_like_python() {
        assert_eq!(fmt_num(80.0), "80");
        assert_eq!(fmt_num(80.5), "80.5");
        assert_eq!(fmt_num(1.0 / 3.0), "0.333333");
        assert_eq!(fmt_num(1_234_567.5), "1.23457e+06");
        assert_eq!(fmt_num(0.000_012_34), "1.234e-05");
        assert_eq!(fmt_num(-0.2), "-0.2");
        assert_eq!(fmt_num(1e20), "100000000000000000000");
        assert_eq!(fmt_num(-0.0), "0");
        assert_eq!(format_g(999_999.5), "1e+06");
    }
}
