//! Randomized differential test of [`zarr_inline::es_number_str`] against the
//! Python reference implementation (`zarr_inline.codec.es_number_str`).
//!
//! Generates a few hundred deterministic f64 bit patterns, formats them in
//! Rust, and compares against one batch `uv run python` subprocess reading
//! hex bit patterns on stdin. Skipped gracefully when `uv` is unavailable.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use zarr_inline::es_number_str;

/// xorshift64* PRNG: deterministic, dependency-free bit patterns.
fn xorshift64star(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    x.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

fn python_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../python")
}

const PYTHON_SCRIPT: &str = r"
import struct, sys
from zarr_inline.codec import es_number_str
for line in sys.stdin:
    line = line.strip()
    if line:
        print(es_number_str(struct.unpack('>d', bytes.fromhex(line))[0]))
";

#[test]
fn es_number_str_matches_python_reference() {
    // Fixed interesting values plus random bit patterns (finite only).
    let mut values: Vec<f64> = vec![
        0.0,
        -0.0,
        1.0,
        1.5,
        1e21,
        1e-7,
        5e-324,
        f64::MIN_POSITIVE, // smallest normal
        f64::MAX,
        123.456,
        1e16,
        1e20,
    ];
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    while values.len() < 400 {
        let bits = xorshift64star(&mut state);
        let value = f64::from_bits(bits);
        if value.is_finite() {
            values.push(value);
        }
        // Mix in modest-exponent values too: raw bit patterns almost never
        // exercise fixed (non-exponential) notation.
        let exponent = 0x3F0 + ((bits >> 56) & 0x3F);
        let small = f64::from_bits((bits & 0x800F_FFFF_FFFF_FFFF) | (exponent << 52));
        if small.is_finite() && values.len() < 400 {
            values.push(small);
        }
    }

    let input: String = values
        .iter()
        .map(|v| format!("{:016x}\n", v.to_bits()))
        .collect();

    let child = Command::new("uv")
        .args(["run", "python", "-c", PYTHON_SCRIPT])
        .current_dir(python_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => {
            eprintln!("skipping differential test: cannot run uv: {e}");
            return;
        }
    };
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(input.as_bytes())
        .expect("write bit patterns to python");
    let output = child.wait_with_output().expect("wait for python");
    if !output.status.success() {
        eprintln!(
            "skipping differential test: uv run python failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let stdout = String::from_utf8(output.stdout).expect("python output is UTF-8");
    let python_texts: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        python_texts.len(),
        values.len(),
        "python printed a different number of lines"
    );
    for (value, python_text) in values.iter().zip(python_texts) {
        assert_eq!(
            es_number_str(*value),
            python_text,
            "bit pattern 0x{:016x} ({value:e})",
            value.to_bits()
        );
    }
}
