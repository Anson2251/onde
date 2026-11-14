//! Hash, HMAC, HKDF and random generation.
//!
//! Deliberately synchronous and tokio-free: `crypto.createHash().update(...)` is CPU work on the
//! isolate thread, not an I/O op. The crate is stateless — `ln-runtime` owns the id→state table
//! so JS can hold an opaque handle.
//!
//! The public types in this file are the M3 contract in `docs/m3-plan.md`.

use hkdf::Hkdf;
use hmac::{Hmac as HmacImpl, Mac};
use ln_error::NodeError;
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512, Sha512_224, Sha512_256};

/// A digest supported by `crypto.createHash` / `createHmac` / `hkdf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Md5,
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512,
    Sha512_224,
    Sha512_256,
}

impl Algorithm {
    /// Accept the canonical Node names (`"sha256"`, `"sha512-256"`, …) case-insensitively.
    ///
    /// OpenSSL spellings (`"sha-256"`, `"sha2-512/224"`, `"RSA-SHA256"`, …) are normalized by the
    /// JavaScript layer (`js/lib/crypto.js`), which owns the Node-facing name table.
    pub fn from_name(name: &str) -> Option<Self> {
        if name.eq_ignore_ascii_case("md5") {
            Some(Algorithm::Md5)
        } else if name.eq_ignore_ascii_case("sha1") {
            Some(Algorithm::Sha1)
        } else if name.eq_ignore_ascii_case("sha224") {
            Some(Algorithm::Sha224)
        } else if name.eq_ignore_ascii_case("sha256") {
            Some(Algorithm::Sha256)
        } else if name.eq_ignore_ascii_case("sha384") {
            Some(Algorithm::Sha384)
        } else if name.eq_ignore_ascii_case("sha512") {
            Some(Algorithm::Sha512)
        } else if name.eq_ignore_ascii_case("sha512-224") {
            Some(Algorithm::Sha512_224)
        } else if name.eq_ignore_ascii_case("sha512-256") {
            Some(Algorithm::Sha512_256)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Algorithm::Md5 => "md5",
            Algorithm::Sha1 => "sha1",
            Algorithm::Sha224 => "sha224",
            Algorithm::Sha256 => "sha256",
            Algorithm::Sha384 => "sha384",
            Algorithm::Sha512 => "sha512",
            Algorithm::Sha512_224 => "sha512-224",
            Algorithm::Sha512_256 => "sha512-256",
        }
    }

    /// Digest length in bytes; also the HKDF `HashLen` of RFC 5869 §2.3.
    fn output_len(self) -> usize {
        match self {
            Algorithm::Md5 => 16,
            Algorithm::Sha1 => 20,
            Algorithm::Sha224 => 28,
            Algorithm::Sha256 => 32,
            Algorithm::Sha384 => 48,
            Algorithm::Sha512 => 64,
            Algorithm::Sha512_224 => 28,
            Algorithm::Sha512_256 => 32,
        }
    }
}

// --- errors ------------------------------------------------------------------------------------
//
// The messages are the byte-for-byte Node v26.10.0 text for `randomInt`/`hkdf` and
// `timingSafeEqual` (probed with `node -e`).

/// Node's `timingSafeEqual` length error: code `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`, and Node
/// v26.10.0 raises it as a `RangeError` (not the `TypeError` one might expect from the "argument
/// error" family).
fn timing_safe_equal_length_error() -> NodeError {
    let mut error = NodeError::new(
        "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
        "Input buffers must have the same byte length",
    );
    error.name = "RangeError";
    error
}

// --- hashing -----------------------------------------------------------------------------------

/// The concrete streaming state behind [`Hash`], so `#[derive(Clone)]` is a real snapshot.
#[derive(Clone)]
enum DigestState {
    Md5(Md5),
    Sha1(Sha1),
    Sha224(Sha224),
    Sha256(Sha256),
    Sha384(Sha384),
    Sha512(Sha512),
    Sha512_224(Sha512_224),
    Sha512_256(Sha512_256),
}

impl DigestState {
    fn new(algorithm: Algorithm) -> Self {
        match algorithm {
            Algorithm::Md5 => DigestState::Md5(Md5::new()),
            Algorithm::Sha1 => DigestState::Sha1(Sha1::new()),
            Algorithm::Sha224 => DigestState::Sha224(Sha224::new()),
            Algorithm::Sha256 => DigestState::Sha256(Sha256::new()),
            Algorithm::Sha384 => DigestState::Sha384(Sha384::new()),
            Algorithm::Sha512 => DigestState::Sha512(Sha512::new()),
            Algorithm::Sha512_224 => DigestState::Sha512_224(Sha512_224::new()),
            Algorithm::Sha512_256 => DigestState::Sha512_256(Sha512_256::new()),
        }
    }

    fn update(&mut self, data: &[u8]) {
        match self {
            DigestState::Md5(state) => state.update(data),
            DigestState::Sha1(state) => state.update(data),
            DigestState::Sha224(state) => state.update(data),
            DigestState::Sha256(state) => state.update(data),
            DigestState::Sha384(state) => state.update(data),
            DigestState::Sha512(state) => state.update(data),
            DigestState::Sha512_224(state) => state.update(data),
            DigestState::Sha512_256(state) => state.update(data),
        }
    }

    fn finish(self) -> Vec<u8> {
        match self {
            DigestState::Md5(state) => state.finalize().to_vec(),
            DigestState::Sha1(state) => state.finalize().to_vec(),
            DigestState::Sha224(state) => state.finalize().to_vec(),
            DigestState::Sha256(state) => state.finalize().to_vec(),
            DigestState::Sha384(state) => state.finalize().to_vec(),
            DigestState::Sha512(state) => state.finalize().to_vec(),
            DigestState::Sha512_224(state) => state.finalize().to_vec(),
            DigestState::Sha512_256(state) => state.finalize().to_vec(),
        }
    }
}

/// A streaming hash. `copy` backs `hash.copy()`, which must not disturb the original.
#[derive(Clone)]
pub struct Hash {
    state: DigestState,
}

impl Hash {
    pub fn new(algorithm: Algorithm) -> Self {
        Self {
            state: DigestState::new(algorithm),
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.state.update(data);
    }

    /// Consume the state and return the digest.
    pub fn finish(self) -> Vec<u8> {
        self.state.finish()
    }

    /// Snapshot the state (Node's `hash.copy()`).
    pub fn copy(&self) -> Self {
        self.clone()
    }
}

// --- HMAC --------------------------------------------------------------------------------------

/// The concrete streaming state behind [`Hmac`]. `hmac::Hmac<D>` is `Clone`, so a copied state
/// is independent of the original.
#[derive(Clone)]
enum HmacState {
    Md5(HmacImpl<Md5>),
    Sha1(HmacImpl<Sha1>),
    Sha224(HmacImpl<Sha224>),
    Sha256(HmacImpl<Sha256>),
    Sha384(HmacImpl<Sha384>),
    Sha512(HmacImpl<Sha512>),
    Sha512_224(HmacImpl<Sha512_224>),
    Sha512_256(HmacImpl<Sha512_256>),
}

impl HmacState {
    fn new(algorithm: Algorithm, key: &[u8]) -> Self {
        // HMAC accepts a key of any length (RFC 2104 §2: long keys are hashed, short keys are
        // zero-padded), so `new_from_slice` cannot fail.
        const ANY_KEY: &str = "HMAC accepts keys of any length";
        match algorithm {
            Algorithm::Md5 => HmacState::Md5(HmacImpl::<Md5>::new_from_slice(key).expect(ANY_KEY)),
            Algorithm::Sha1 => {
                HmacState::Sha1(HmacImpl::<Sha1>::new_from_slice(key).expect(ANY_KEY))
            }
            Algorithm::Sha224 => {
                HmacState::Sha224(HmacImpl::<Sha224>::new_from_slice(key).expect(ANY_KEY))
            }
            Algorithm::Sha256 => {
                HmacState::Sha256(HmacImpl::<Sha256>::new_from_slice(key).expect(ANY_KEY))
            }
            Algorithm::Sha384 => {
                HmacState::Sha384(HmacImpl::<Sha384>::new_from_slice(key).expect(ANY_KEY))
            }
            Algorithm::Sha512 => {
                HmacState::Sha512(HmacImpl::<Sha512>::new_from_slice(key).expect(ANY_KEY))
            }
            Algorithm::Sha512_224 => {
                HmacState::Sha512_224(HmacImpl::<Sha512_224>::new_from_slice(key).expect(ANY_KEY))
            }
            Algorithm::Sha512_256 => {
                HmacState::Sha512_256(HmacImpl::<Sha512_256>::new_from_slice(key).expect(ANY_KEY))
            }
        }
    }

    fn update(&mut self, data: &[u8]) {
        match self {
            HmacState::Md5(state) => state.update(data),
            HmacState::Sha1(state) => state.update(data),
            HmacState::Sha224(state) => state.update(data),
            HmacState::Sha256(state) => state.update(data),
            HmacState::Sha384(state) => state.update(data),
            HmacState::Sha512(state) => state.update(data),
            HmacState::Sha512_224(state) => state.update(data),
            HmacState::Sha512_256(state) => state.update(data),
        }
    }

    fn finish(self) -> Vec<u8> {
        match self {
            HmacState::Md5(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha1(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha224(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha256(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha384(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha512(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha512_224(state) => state.finalize().into_bytes().to_vec(),
            HmacState::Sha512_256(state) => state.finalize().into_bytes().to_vec(),
        }
    }
}

/// A streaming HMAC, same shape as [`Hash`].
#[derive(Clone)]
pub struct Hmac {
    state: HmacState,
}

impl Hmac {
    pub fn new(algorithm: Algorithm, key: &[u8]) -> Self {
        Self {
            state: HmacState::new(algorithm, key),
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.state.update(data);
    }

    pub fn finish(self) -> Vec<u8> {
        self.state.finish()
    }
}

// --- random ------------------------------------------------------------------------------------

/// Fill `bytes` from the OS entropy source. Node treats an unavailable entropy source as fatal
/// (`ERR_CRYPTO_...` / process abort), and there is nothing a caller could retry meaningfully.
fn fill_random(bytes: &mut [u8]) {
    if let Err(error) = getrandom::getrandom(bytes) {
        panic!("ln-crypto: the OS entropy source is unavailable: {error}");
    }
}

/// Cryptographically secure bytes (`randomBytes`). Panics only if the OS entropy source fails,
/// which Node treats as fatal too.
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; len];
    fill_random(&mut bytes);
    bytes
}

/// Uniform integer in `[min, max)` with rejection sampling (`randomInt`).
pub fn random_int(min: i64, max: i64) -> Result<i64, NodeError> {
    if min >= max {
        return Err(NodeError::out_of_range(
            "max",
            &format!("must be greater than the value of \"min\" ({min})"),
            &max.to_string(),
        ));
    }

    // The width fits in `u128` even for `i64::MIN..i64::MAX` (2^64 - 1); the `u64` draw is then
    // mapped with one rejection step so every result is exactly uniform.
    let width = (max as i128 - min as i128) as u128;
    let threshold = (1_u128 << 64) % width;
    loop {
        let mut bytes = [0_u8; 8];
        fill_random(&mut bytes);
        let sample = u128::from(u64::from_le_bytes(bytes));
        if sample >= threshold {
            // `min + sample % width` is in `[min, max)` and therefore representable as `i64`.
            return Ok((min as i128 + (sample % width) as i128) as i64);
        }
    }
}

/// RFC 4122 version 4 UUID (`randomUUID`).
pub fn random_uuid() -> String {
    let mut bytes = [0_u8; 16];
    fill_random(&mut bytes);

    // Version 4 (random) and RFC 4122 variant (10xx).
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let mut uuid = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            uuid.push('-');
        }
        uuid.push_str(&format!("{byte:02x}"));
    }
    uuid
}

// --- comparison --------------------------------------------------------------------------------

/// Constant-time comparison (`timingSafeEqual`). Length mismatch is `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`.
pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> Result<bool, NodeError> {
    if a.len() != b.len() {
        return Err(timing_safe_equal_length_error());
    }

    let mut difference = 0_u8;
    for (left, right) in a.iter().zip(b.iter()) {
        difference |= left ^ right;
    }
    // Keep the accumulator opaque so a future optimizer cannot turn the loop into an early exit.
    Ok(std::hint::black_box(difference) == 0)
}

// --- HKDF --------------------------------------------------------------------------------------

/// HKDF (`crypto.hkdf`), extract-and-expand with the given digest.
///
/// The output length is bounded by `255 * HashLen` (RFC 5869 §2.3); a longer request is
/// `ERR_OUT_OF_RANGE`. Node itself reports `ERR_CRYPTO_INVALID_KEYLEN` from `hkdfSync` for the
/// same condition — the JS surface throws that Node-shaped error before reaching here.
pub fn hkdf(
    algorithm: Algorithm,
    ikm: &[u8],
    salt: &[u8],
    info: &[u8],
    len: usize,
) -> Result<Vec<u8>, NodeError> {
    let max_len = 255 * algorithm.output_len();
    if len > max_len {
        return Err(NodeError::out_of_range(
            "length",
            &format!("<= {max_len}"),
            &len.to_string(),
        ));
    }

    let mut output = vec![0_u8; len];
    // `expand` only fails when the output is longer than `255 * HashLen`, which was checked
    // above against the same hash, so the result is infallible here.
    macro_rules! expand {
        ($hash:ty) => {{
            Hkdf::<$hash>::new(Some(salt), ikm)
                .expand(info, &mut output)
                .expect("HKDF output length is bounded by 255 * HashLen");
        }};
    }
    match algorithm {
        Algorithm::Md5 => expand!(Md5),
        Algorithm::Sha1 => expand!(Sha1),
        Algorithm::Sha224 => expand!(Sha224),
        Algorithm::Sha256 => expand!(Sha256),
        Algorithm::Sha384 => expand!(Sha384),
        Algorithm::Sha512 => expand!(Sha512),
        Algorithm::Sha512_224 => expand!(Sha512_224),
        Algorithm::Sha512_256 => expand!(Sha512_256),
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Decode a lowercase/uppercase hex literal (test vectors are written as hex, which is how
    /// NIST/RFC publish them; no dev-dependency needed for that).
    fn hex(input: &str) -> Vec<u8> {
        assert_eq!(input.len() % 2, 0, "hex literal has an even length");
        (0..input.len())
            .step_by(2)
            .map(|index| {
                u8::from_str_radix(&input[index..index + 2], 16).expect("valid hex literal")
            })
            .collect()
    }

    fn unhex(input: &str) -> String {
        input.replace(' ', "")
    }

    #[test]
    fn algorithm_names_are_case_insensitive() {
        assert_eq!(Algorithm::from_name("md5"), Some(Algorithm::Md5));
        assert_eq!(Algorithm::from_name("SHA1"), Some(Algorithm::Sha1));
        assert_eq!(Algorithm::from_name("Sha224"), Some(Algorithm::Sha224));
        assert_eq!(Algorithm::from_name("Sha256"), Some(Algorithm::Sha256));
        assert_eq!(Algorithm::from_name("sHa384"), Some(Algorithm::Sha384));
        assert_eq!(Algorithm::from_name("sha512"), Some(Algorithm::Sha512));
        assert_eq!(
            Algorithm::from_name("SHA512-224"),
            Some(Algorithm::Sha512_224)
        );
        assert_eq!(
            Algorithm::from_name("sha512-256"),
            Some(Algorithm::Sha512_256)
        );
        // OpenSSL spellings and unsupported digests are not resolved here: the JS layer owns the
        // Node-facing name table (`js/lib/crypto.js`).
        assert_eq!(Algorithm::from_name("sha-256"), None);
        assert_eq!(Algorithm::from_name("sha3-256"), None);
        assert_eq!(Algorithm::from_name("RSA-SHA256"), None);
        assert_eq!(Algorithm::from_name("sha256/192"), None);
        assert_eq!(Algorithm::from_name(""), None);
        assert_eq!(Algorithm::from_name(" sha256 "), None);
    }

    #[test]
    fn algorithm_names_round_trip() {
        for algorithm in [
            Algorithm::Md5,
            Algorithm::Sha1,
            Algorithm::Sha224,
            Algorithm::Sha256,
            Algorithm::Sha384,
            Algorithm::Sha512,
            Algorithm::Sha512_224,
            Algorithm::Sha512_256,
        ] {
            assert_eq!(Algorithm::from_name(algorithm.name()), Some(algorithm));
        }
    }

    #[test]
    fn hashes_match_fips_vectors_for_abc() {
        let abc = b"abc";
        let cases = [
            (Algorithm::Md5, "900150983cd24fb0d6963f7d28e17f72"),
            (Algorithm::Sha1, "a9993e364706816aba3e25717850c26c9cd0d89d"),
            (
                Algorithm::Sha224,
                "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
            ),
            (
                Algorithm::Sha256,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                Algorithm::Sha384,
                "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed\
                 8086072ba1e7cc2358baeca134c825a7",
            ),
            (
                Algorithm::Sha512,
                "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
                 2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
            ),
            (
                Algorithm::Sha512_224,
                "4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa",
            ),
            (
                Algorithm::Sha512_256,
                "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23",
            ),
        ];
        for (algorithm, expected) in cases {
            let mut hash = Hash::new(algorithm);
            hash.update(abc);
            assert_eq!(hash.finish(), hex(&unhex(expected)), "{}", algorithm.name());
        }
    }

    #[test]
    fn streaming_updates_match_a_single_update() {
        let mut chunked = Hash::new(Algorithm::Sha256);
        chunked.update(b"a");
        chunked.update(b"b");
        chunked.update(b"c");
        let mut whole = Hash::new(Algorithm::Sha256);
        whole.update(b"abc");
        assert_eq!(chunked.finish(), whole.finish());
    }

    #[test]
    fn copy_is_an_independent_snapshot() {
        let mut original = Hash::new(Algorithm::Sha256);
        original.update(b"abc");
        let snapshot = original.copy();

        original.update(b"def");
        let mut whole = Hash::new(Algorithm::Sha256);
        whole.update(b"abcdef");
        assert_eq!(original.finish(), whole.finish());

        // The copy kept the state from before the second update.
        assert_eq!(
            snapshot.finish(),
            hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_case_1() {
        let mut hmac = Hmac::new(Algorithm::Sha256, &[0x0b; 20]);
        hmac.update(b"Hi There");
        assert_eq!(
            hmac.finish(),
            hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_case_2() {
        let mut hmac = Hmac::new(Algorithm::Sha256, b"Jefe");
        hmac.update(b"what do ya want for nothing?");
        assert_eq!(
            hmac.finish(),
            hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
        );
    }

    #[test]
    fn hmac_supports_every_algorithm_and_any_key_length() {
        for algorithm in [
            Algorithm::Md5,
            Algorithm::Sha1,
            Algorithm::Sha224,
            Algorithm::Sha256,
            Algorithm::Sha384,
            Algorithm::Sha512,
            Algorithm::Sha512_224,
            Algorithm::Sha512_256,
        ] {
            let mut short = Hmac::new(algorithm, b"");
            short.update(b"x");
            let digest = short.finish();
            assert_eq!(digest.len(), algorithm.output_len());

            let mut long = Hmac::new(algorithm, &[0xaa; 200]);
            long.update(b"x");
            assert_eq!(long.finish().len(), algorithm.output_len());
        }
    }

    #[test]
    fn hkdf_sha256_matches_rfc_5869_case_1() {
        let ikm = [0x0b; 22];
        let salt = hex("000102030405060708090a0b0c");
        let info = hex("f0f1f2f3f4f5f6f7f8f9");
        let output = hkdf(Algorithm::Sha256, &ikm, &salt, &info, 42).expect("valid length");
        assert_eq!(
            output,
            hex("3cb25f25faacd57a90434f64d0362f2a\
                 2d2d0a90cf1a5a4c5db02d56ecc4c5bf\
                 34007208d5b887185865")
        );
    }

    #[test]
    fn hkdf_sha256_matches_rfc_5869_case_3_empty_salt_and_info() {
        let output = hkdf(Algorithm::Sha256, &[0x0b; 22], &[], &[], 42).expect("valid length");
        assert_eq!(
            output,
            hex("8da4e775a563c18f715f802a063c5a31\
                 b8a11f5c5ee1879ec3454e5f3c738d2d\
                 9d201395faa4b61a96c8")
        );
    }

    #[test]
    fn hkdf_rejects_an_oversized_output() {
        let error = hkdf(Algorithm::Sha256, b"ikm", b"salt", b"info", 8161)
            .expect_err("8161 bytes exceed 255 * 32");
        assert_eq!(error.code, "ERR_OUT_OF_RANGE");
        assert_eq!(error.name, "RangeError");
        assert!(error.message.contains("8160"), "message: {}", error.message);

        assert!(hkdf(Algorithm::Sha256, b"ikm", b"salt", b"info", 8160).is_ok());
    }

    #[test]
    fn hkdf_works_for_every_algorithm() {
        for algorithm in [
            Algorithm::Md5,
            Algorithm::Sha1,
            Algorithm::Sha224,
            Algorithm::Sha256,
            Algorithm::Sha384,
            Algorithm::Sha512,
            Algorithm::Sha512_224,
            Algorithm::Sha512_256,
        ] {
            let max = 255 * algorithm.output_len();
            let output = hkdf(algorithm, b"ikm", b"salt", b"info", max).expect("max length");
            assert_eq!(output.len(), max, "{}", algorithm.name());
            assert!(hkdf(algorithm, b"ikm", b"salt", b"info", max + 1).is_err());
        }
    }

    #[test]
    fn random_bytes_has_the_requested_length() {
        assert!(random_bytes(0).is_empty());
        assert_eq!(random_bytes(1).len(), 1);
        assert_eq!(random_bytes(32).len(), 32);
        assert_eq!(random_bytes(65).len(), 65);
        // Two independent 32-byte draws colliding is a 2^-256 event.
        assert_ne!(random_bytes(32), random_bytes(32));
    }

    #[test]
    fn random_int_stays_inside_the_bounds() {
        for _ in 0..1000 {
            let value = random_int(-5, 7).expect("valid range");
            assert!((-5..7).contains(&value), "{value} outside [-5, 7)");
        }
        assert_eq!(random_int(0, 1).expect("valid range"), 0);
    }

    #[test]
    fn random_int_covers_the_whole_small_range() {
        let mut seen = [false; 2];
        for _ in 0..1000 {
            let value = random_int(-1, 1).expect("valid range");
            let index = usize::from(value == 0);
            seen[index] = true;
        }
        assert!(seen[0] && seen[1], "both outcomes of [-1, 1) were drawn");
    }

    #[test]
    fn random_int_handles_the_full_i64_range() {
        for _ in 0..100 {
            let value = random_int(i64::MIN, i64::MAX).expect("valid range");
            assert!(value < i64::MAX);
        }
        let value = random_int(i64::MAX - 1, i64::MAX).expect("valid range");
        assert_eq!(value, i64::MAX - 1);
    }

    #[test]
    fn random_int_rejects_an_empty_or_inverted_range() {
        for (min, max) in [(0, 0), (5, 4), (i64::MAX, i64::MIN)] {
            let error = random_int(min, max).expect_err("min must be below max");
            assert_eq!(error.code, "ERR_OUT_OF_RANGE");
            assert_eq!(error.name, "RangeError");
            assert!(
                error
                    .message
                    .starts_with("The value of \"max\" is out of range."),
                "message: {}",
                error.message
            );
        }
    }

    #[test]
    fn random_uuid_is_version_4_and_unique() {
        let mut seen = HashSet::new();
        for _ in 0..1000 {
            let uuid = random_uuid();
            assert_eq!(uuid.len(), 36, "uuid: {uuid}");
            let bytes: Vec<char> = uuid.chars().collect();
            for position in [8, 13, 18, 23] {
                assert_eq!(bytes[position], '-', "uuid: {uuid}");
            }
            for (position, character) in bytes.iter().enumerate() {
                if position == 8 || position == 13 || position == 18 || position == 23 {
                    continue;
                }
                assert!(
                    character.is_ascii_hexdigit() && !character.is_ascii_uppercase(),
                    "uuid: {uuid}"
                );
            }
            assert_eq!(bytes[14], '4', "version nibble: {uuid}");
            assert!(
                matches!(bytes[19], '8' | '9' | 'a' | 'b'),
                "variant nibble: {uuid}"
            );
            assert!(seen.insert(uuid), "duplicate uuid");
        }
        assert_eq!(seen.len(), 1000);
    }

    #[test]
    fn timing_safe_equal_compares_bytes() {
        assert!(timing_safe_equal(b"abc", b"abc").expect("equal lengths"));
        assert!(!timing_safe_equal(b"abc", b"abd").expect("equal lengths"));
        assert!(timing_safe_equal(b"", b"").expect("equal lengths"));
        assert!(!timing_safe_equal(b"\x00", b"\xff").expect("equal lengths"));
    }

    #[test]
    fn timing_safe_equal_rejects_mismatched_lengths() {
        let error = timing_safe_equal(b"ab", b"abc").expect_err("different lengths");
        assert_eq!(error.code, "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH");
        assert_eq!(error.name, "RangeError");
        assert_eq!(
            error.message,
            "Input buffers must have the same byte length"
        );
    }
}
