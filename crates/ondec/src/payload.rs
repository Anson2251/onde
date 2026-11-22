//! Encoding the payload.
//!
//! The format lives in `ln-payload` (the same code the runtime parses with); this module is the
//! build-tool side: it decides which asset is which kind, chooses the entry, and optionally
//! compresses the whole image.

use std::io::Write as _;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use ln_payload::{Builder, Codec, Kind};

/// One module as the payload stores it: a key, the bytes, and how to read them.
#[derive(Debug, Clone)]
pub struct Asset {
    /// The payload key (the bundler's output filename relative to the project root).
    pub key: String,
    /// Bytecode, or source with `--no-bytecode`.
    pub body: Vec<u8>,
    /// Which of the two.
    pub kind: Kind,
}

/// Encode `assets` into a payload whose entry is `entry`.
///
/// Compression is off by default: bytecode compresses 3–4×, but inflating it costs about 1.4 ms
/// per MiB on the startup path, and this project does not trade run-time performance for package
/// size. `--compress` opts in.
pub fn encode(
    stamp: &ln_abi::Stamp,
    assets: &[Asset],
    entry: &str,
    compression: Option<CompressionSetting>,
) -> Result<Vec<u8>, String> {
    let mut builder = Builder::new(stamp).map_err(|error| error.to_string())?;
    for asset in assets {
        builder
            .push(&asset.key, asset.kind, &asset.body)
            .map_err(|error| error.to_string())?;
    }
    builder
        .set_entry(entry)
        .map_err(|error| error.to_string())?;
    let image = builder.build().map_err(|error| error.to_string())?;

    let Some(setting) = compression else {
        return Ok(image);
    };
    ln_payload::compress(&image, setting.codec, |raw| match setting.codec {
        Codec::Zlib => {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(setting.level as u32));
            encoder.write_all(raw).map_err(|error| {
                ln_payload::Error::from_message(format!("compress zlib payload: {error}"))
            })?;
            encoder.finish().map_err(|error| {
                ln_payload::Error::from_message(format!("compress zlib payload: {error}"))
            })
        }
        Codec::Zstd => zstd::bulk::compress(raw, setting.level).map_err(|error| {
            ln_payload::Error::from_message(format!("compress zstd payload: {error}"))
        }),
    })
    .map_err(|error| error.to_string())
}

/// A codec and its level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompressionSetting {
    /// Which stream format.
    pub codec: Codec,
    /// Codec-specific level: 1–9 for zlib, 1–22 for zstd.
    pub level: i32,
}

impl CompressionSetting {
    /// Parse `none`, `zlib`, `zlib:<level>`, `zstd`, `zstd:<level>`.
    ///
    /// Levels are codec-specific on purpose: zlib's whole range produces the same size on
    /// bytecode (measured), while zstd's last levels are where the size is. Defaults: zlib 6,
    /// zstd 9 (the point where the ratio stops improving for free).
    pub fn parse(spec: &str) -> Result<Option<CompressionSetting>, String> {
        let spec = spec.trim();
        if spec.is_empty() || spec == "none" {
            return Ok(None);
        }
        let (codec, level) = match spec.split_once(':') {
            Some((codec, level)) => (codec, Some(level)),
            None => (spec, None),
        };
        let codec = match codec {
            "zlib" => Codec::Zlib,
            "zstd" => Codec::Zstd,
            other => {
                return Err(format!(
                    "unknown codec {other:?}; expected none, zlib[:level] or zstd[:level]"
                ))
            }
        };
        let default = match codec {
            Codec::Zlib => 6,
            Codec::Zstd => 9,
        };
        let level = match level {
            Some(level) => level
                .parse::<i32>()
                .map_err(|_| format!("{level:?} is not a compressor level"))?,
            None => default,
        };
        let range = match codec {
            Codec::Zlib => 1..=9,
            Codec::Zstd => 1..=22,
        };
        if !range.contains(&level) {
            return Err(format!(
                "{} level {level} is outside {:?}",
                codec.as_str(),
                range
            ));
        }
        Ok(Some(CompressionSetting { codec, level }))
    }

    /// `zstd:19`, for the report.
    pub fn label(&self) -> String {
        format!("{}:{}", self.codec.as_str(), self.level)
    }
}

/// What the payload contains, for the build report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    /// Number of modules.
    pub modules: usize,
    /// Total bytes of module bodies (before the table and header).
    pub bytes: usize,
}

/// A summary of a built asset list.
pub fn summarize(assets: &[Asset]) -> Summary {
    Summary {
        modules: assets.len(),
        bytes: assets.iter().map(|asset| asset.body.len()).sum(),
    }
}

/// The kind for a bundled chunk: bytecode unless `--no-bytecode` asked for source.
pub fn chunk_kind(no_bytecode: bool) -> Kind {
    if no_bytecode {
        Kind::Source
    } else {
        Kind::Bytecode
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ln_payload::{Parsed, Payload};

    fn assets() -> Vec<Asset> {
        vec![
            Asset {
                key: "entry.js".to_owned(),
                body: b"export {};".to_vec(),
                kind: Kind::Bytecode,
            },
            Asset {
                key: "chunks/a.js".to_owned(),
                body: b"export const a = 1;".to_vec(),
                kind: Kind::Bytecode,
            },
        ]
    }

    #[test]
    fn encodes_the_entry_and_every_module() {
        let stamp = ln_engine::engine_stamp_parsed();
        let image = encode(&stamp, &assets(), "entry.js", None).expect("encode");
        let Parsed::Image(payload) = Payload::parse(&image).expect("parse") else {
            panic!("expected an uncompressed payload");
        };
        assert_eq!(payload.entry().key, "entry.js");
        assert_eq!(payload.header().module_count, 2);
        assert_eq!(payload.entry().body, b"export {};");
    }

    #[test]
    fn compressed_payloads_are_flagged_and_parse_to_the_same_image() {
        let stamp = ln_engine::engine_stamp_parsed();
        let image = encode(&stamp, &assets(), "entry.js", None).unwrap();
        let compressed = encode(
            &stamp,
            &assets(),
            "entry.js",
            Some(CompressionSetting {
                codec: Codec::Zlib,
                level: 6,
            }),
        )
        .unwrap();
        assert!(
            compressed.len() < image.len(),
            "compression should shrink a repeated export: {} vs {}",
            compressed.len(),
            image.len()
        );
        match Payload::parse(&compressed).expect("parse") {
            Parsed::Compressed {
                total_len, codec, ..
            } => {
                assert_eq!(total_len, image.len());
                assert_eq!(codec, Codec::Zlib);
            }
            Parsed::Image(_) => panic!("expected the compressed variant"),
        }
    }

    #[test]
    fn compression_specs_are_parsed_with_codec_specific_levels() {
        assert_eq!(CompressionSetting::parse("none"), Ok(None));
        assert_eq!(
            CompressionSetting::parse("zlib"),
            Ok(Some(CompressionSetting {
                codec: Codec::Zlib,
                level: 6
            }))
        );
        assert_eq!(
            CompressionSetting::parse("zstd:19"),
            Ok(Some(CompressionSetting {
                codec: Codec::Zstd,
                level: 19
            }))
        );
        assert!(CompressionSetting::parse("zstd:23").is_err());
        assert!(CompressionSetting::parse("zlib:0").is_err());
        assert!(CompressionSetting::parse("gzip").is_err());
    }

    #[test]
    fn the_summary_counts_modules_and_bytes() {
        let summary = summarize(&assets());
        assert_eq!(summary.modules, 2);
        assert_eq!(
            summary.bytes,
            "export {};".len() + "export const a = 1;".len()
        );
    }
}
