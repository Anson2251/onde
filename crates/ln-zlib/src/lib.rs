//! gzip / zlib / raw-deflate and crc32, engine-free and tokio-free.
//!
//! `flate2` with the pure-Rust `miniz_oxide` backend: no C toolchain, no system zlib. This is the
//! crate behind `node:zlib`; the JS surface lives in `js/lib/zlib.js` and the host primitive in
//! `ln-runtime/src/host/zlib.rs`.

use std::io::Read;

use flate2::read::{DeflateDecoder, GzDecoder, MultiGzDecoder, ZlibDecoder};
use flate2::{Compression, Crc};
use ln_error::NodeError;

/// Which wrapper the compressed bytes carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// `gzip`: RFC 1952, with a header and trailer (`zlib.gzip*` / `zlib.gunzip*`).
    Gzip,
    /// `zlib`: RFC 1950, the two-byte header (`zlib.deflate*` / `zlib.inflate*`).
    Zlib,
    /// Raw DEFLATE: RFC 1951, no wrapper (`zlib.deflateRaw*` / `zlib.inflateRaw*`).
    Raw,
}

impl Format {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "gzip" => Some(Format::Gzip),
            "zlib" => Some(Format::Zlib),
            "raw" => Some(Format::Raw),
            _ => None,
        }
    }
}

/// The code Node uses for a corrupt stream.
fn data_error(message: impl Into<String>) -> NodeError {
    NodeError::new("Z_DATA_ERROR", message)
}

/// Truncated input: Node reports `Z_BUF_ERROR` ("unexpected end of file").
fn buf_error(message: impl Into<String>) -> NodeError {
    NodeError::new("Z_BUF_ERROR", message)
}

fn too_large(limit: usize) -> NodeError {
    NodeError::new(
        "ERR_BUFFER_TOO_LARGE",
        format!("Cannot create a Buffer larger than maxOutputLength ({limit})"),
    )
}

/// `zlib.crc32`: the IEEE 802.3 polynomial, as a signed 32-bit value like Node's.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(data);
    crc.sum()
}

/// Decompress `data` in `format`, refusing to allocate more than `max_output` bytes.
///
/// `max_output == 0` means "no explicit limit" (the caller validates the argument); the guard
/// reads one byte past the limit so an over-long stream is detected instead of silently truncated.
pub fn decompress(format: Format, data: &[u8], max_output: usize) -> Result<Vec<u8>, NodeError> {
    let limit = if max_output == 0 {
        u64::MAX
    } else {
        max_output as u64 + 1
    };
    let mut out = Vec::new();
    let outcome = match format {
        // Multi-member gzip: Node accepts concatenated members, and a single-member decoder
        // silently stops at the first one.
        Format::Gzip => MultiGzDecoder::new(data).take(limit).read_to_end(&mut out),
        Format::Zlib => ZlibDecoder::new(data).take(limit).read_to_end(&mut out),
        Format::Raw => DeflateDecoder::new(data).take(limit).read_to_end(&mut out),
    };
    outcome.map_err(|error| match error.kind() {
        std::io::ErrorKind::UnexpectedEof => buf_error("unexpected end of file"),
        _ => data_error(format!("invalid compressed data: {error}")),
    })?;
    if max_output != 0 && out.len() > max_output {
        return Err(too_large(max_output));
    }
    // A wrapped stream that ends early (no trailer) reads as success with no error on some
    // backends; `MultiGzDecoder` reports it, the zlib decoder does too, so nothing extra here.
    Ok(out)
}

/// Compress `data` in `format` at `level` (`-1` is the backend default, `0`..=`9` explicit).
pub fn compress(format: Format, data: &[u8], level: i32) -> Result<Vec<u8>, NodeError> {
    let compression = if level < 0 {
        Compression::default()
    } else {
        Compression::new(level.min(9) as u32)
    };
    let mut out = Vec::new();
    let outcome = match format {
        Format::Gzip => {
            let mut encoder = flate2::write::GzEncoder::new(&mut out, compression);
            std::io::Write::write_all(&mut encoder, data)
                .and_then(|()| encoder.finish().map(|_| ()))
        }
        Format::Zlib => {
            let mut encoder = flate2::write::ZlibEncoder::new(&mut out, compression);
            std::io::Write::write_all(&mut encoder, data)
                .and_then(|()| encoder.finish().map(|_| ()))
        }
        Format::Raw => {
            let mut encoder = flate2::write::DeflateEncoder::new(&mut out, compression);
            std::io::Write::write_all(&mut encoder, data)
                .and_then(|()| encoder.finish().map(|_| ()))
        }
    };
    outcome.map_err(|error| data_error(format!("compression failed: {error}")))?;
    Ok(out)
}

/// True when `data` is a single complete gzip member (used by the concatenation test).
pub fn is_gzip(data: &[u8]) -> bool {
    let mut probe = [0u8; 2];
    GzDecoder::new(data).read_exact(&mut probe).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_round_trips_and_accepts_concatenated_members() {
        let a = compress(Format::Gzip, b"hello ", -1).expect("gzip a");
        let b = compress(Format::Gzip, b"world", -1).expect("gzip b");
        assert_eq!(decompress(Format::Gzip, &a, 0).expect("gunzip"), b"hello ");

        let mut both = a.clone();
        both.extend_from_slice(&b);
        assert_eq!(
            decompress(Format::Gzip, &both, 0).expect("gunzip concatenated"),
            b"hello world",
            "a single-member decoder would stop after the first member"
        );
    }

    #[test]
    fn zlib_and_raw_round_trip() {
        for format in [Format::Zlib, Format::Raw] {
            let packed = compress(format, b"onde", 6).expect("compress");
            assert_eq!(decompress(format, &packed, 0).expect("decompress"), b"onde");
        }
    }

    #[test]
    fn every_level_round_trips() {
        for level in [-1, 0, 1, 9] {
            let packed = compress(Format::Gzip, b"level", level).expect("compress");
            assert_eq!(
                decompress(Format::Gzip, &packed, 0).expect("decompress"),
                b"level"
            );
        }
    }

    #[test]
    fn corrupt_input_is_z_data_error() {
        let error = decompress(Format::Gzip, b"not gzip at all", 0).expect_err("corrupt");
        assert_eq!(error.code, "Z_DATA_ERROR");
    }

    #[test]
    fn truncated_input_is_z_buf_error() {
        let packed = compress(Format::Gzip, b"truncated payload here", 6).expect("compress");
        let error =
            decompress(Format::Gzip, &packed[..packed.len() - 4], 0).expect_err("truncated");
        assert!(
            error.code == "Z_BUF_ERROR" || error.code == "Z_DATA_ERROR",
            "unexpected code {}",
            error.code
        );
    }

    #[test]
    fn a_corrupt_crc_is_an_error() {
        let mut packed = compress(Format::Gzip, b"checksum", 6).expect("compress");
        let last = packed.len() - 5; // inside the 8-byte trailer
        packed[last] ^= 0xff;
        let error = decompress(Format::Gzip, &packed, 0).expect_err("crc mismatch");
        assert_eq!(error.code, "Z_DATA_ERROR");
    }

    #[test]
    fn max_output_length_is_enforced() {
        let packed = compress(Format::Gzip, &[b'x'; 4096], 6).expect("compress");
        let error = decompress(Format::Gzip, &packed, 1024).expect_err("over the limit");
        assert_eq!(error.code, "ERR_BUFFER_TOO_LARGE");
        assert_eq!(
            decompress(Format::Gzip, &packed, 4096)
                .expect("at the limit")
                .len(),
            4096
        );
    }

    #[test]
    fn crc32_matches_known_vectors() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn empty_input_round_trips() {
        let packed = compress(Format::Gzip, b"", 6).expect("compress");
        assert_eq!(
            decompress(Format::Gzip, &packed, 0).expect("decompress"),
            b""
        );
    }
}
