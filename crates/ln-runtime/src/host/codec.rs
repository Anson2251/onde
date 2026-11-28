//! Base64 and hex, the two Buffer codecs worth a native implementation.
//!
//! Both were JavaScript loops in `internal/bytes.js`, one character or byte at a time. A 1 KB
//! `Buffer.from(base64)` cost 196 µs and a 1 KB `toString("hex")` 129 µs, against Node's
//! 0.17 µs and 0.57 µs: the engine, not the algorithm, was the cost. The same table lookup in
//! Rust measures 1.5–2.8 µs per kilobyte end to end, most of it the string/array conversion at
//! the host boundary rather than the loop.
//!
//! The standard base64 encoder and the 4-to-3 packing both come from the `base64` crate; the
//! decoder keeps a small Node-compat sanitizer in front of it, because Node's decode semantics
//! are not RFC 4648's:
//!
//! * base64 decode accepts both the standard and the URL-safe alphabet regardless of the flag,
//!   ignores everything outside the alphabet (whitespace included), stops at the first `=`, and
//!   drops a trailing character that cannot fill a whole byte. A small sanitizer normalises the
//!   input and the `base64` crate performs the packing;
//! * both decoders mask each UTF-16 code unit to one byte before the table lookup, because that
//!   is what Node's decoders do: `"š"` (U+0161) is the hex digit `a`, and a surrogate such as
//!   U+D83D is `=`, which ends base64 decoding.
//!
//! The `&str` signature means a lone surrogate cannot reach these functions at all (the engine
//! renders the JS string as CESU-8, which is not UTF-8); `internal/bytes.js` sends only
//! well-formed strings here and uses its JavaScript loop for the rest.

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine as _;

/// Node's decoder is RFC 4648 with three deviations that matter here: it ignores every character
/// outside the alphabet, it accepts both the standard and URL-safe spellings, and a final group of
/// one character contributes no byte. The sanitizer below normalises those; the engine then does
/// the 4-to-3 packing. `allow_trailing_bits` covers Node ignoring non-zero bits in the last byte.
const NODE_BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Standard base64 with padding, or the URL-safe alphabet without it.
///
/// This is exactly RFC 4648, so it is the crate's encoder rather than a local loop.
pub(super) fn encode_base64(bytes: &[u8], url_safe: bool) -> String {
    if url_safe {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    } else {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}

/// Node-lenient base64 decode.
///
/// The sanitizer is the Node semantics: walk UTF-16 code units (Node masks each one to a byte, so
/// `"š"` is `a` and a surrogate is `=`), stop at the first `=`, drop every non-alphabet character,
/// map the URL-safe spellings, and ignore a final group of one character. The `base64` engine then
/// does the standard 4-to-3 packing; it never sees a character Node would have skipped.
pub(super) fn decode_base64(text: &str, _url_safe: bool) -> Vec<u8> {
    NODE_BASE64
        .decode(sanitize_base64(text))
        .unwrap_or_default()
}

fn sanitize_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for unit in text.encode_utf16() {
        // Node masks the UTF-16 code unit to one byte before its table lookup.
        let code = (unit & 0xff) as u8;
        let mapped = match code {
            b'=' => break,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => code,
            b'-' => b'+',
            b'_' => b'/',
            _ => continue,
        };
        out.push(mapped);
    }
    // A trailing group of one character cannot produce a byte; Node drops it rather than failing.
    if out.len() % 4 == 1 {
        out.pop();
    }
    out
}
const HEX_DIGITS: [u8; 16] = *b"0123456789abcdef";

const HEX_VALUES: [i8; 256] = {
    let mut table = [-1_i8; 256];
    let mut value = 0;
    while value < 10 {
        table[b'0' as usize + value] = value as i8;
        value += 1;
    }
    let mut digit = 0;
    while digit < 6 {
        table[b'A' as usize + digit] = 10 + digit as i8;
        table[b'a' as usize + digit] = 10 + digit as i8;
        digit += 1;
    }
    table
};

pub(super) fn encode_hex(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX_DIGITS[usize::from(byte >> 4)]);
        out.push(HEX_DIGITS[usize::from(byte & 0x0f)]);
    }
    // Every byte comes from the lowercase hex alphabet, so this cannot fail.
    String::from_utf8(out).expect("hex digits are ASCII")
}

pub(super) fn decode_hex(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 2);
    let mut units = text.encode_utf16();

    // An odd trailing digit has no partner, so it falls out of the pattern and is dropped.
    while let (Some(high), Some(low)) = (units.next(), units.next()) {
        let high = HEX_VALUES[usize::from(high & 0xff)];
        let low = HEX_VALUES[usize::from(low & 0xff)];
        if high < 0 || low < 0 {
            break;
        }
        out.push(((high as u8) << 4) | low as u8);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(encode_base64(&[], false), "");
        assert_eq!(encode_base64(&[], true), "");
        assert_eq!(decode_base64("", false), Vec::<u8>::new());
        assert_eq!(encode_hex(&[]), "");
        assert_eq!(decode_hex(""), Vec::<u8>::new());
    }

    #[test]
    fn base64_padding_matches_rfc4648() {
        assert_eq!(encode_base64(b"f", false), "Zg==");
        assert_eq!(encode_base64(b"fo", false), "Zm8=");
        assert_eq!(encode_base64(b"foo", false), "Zm9v");
        assert_eq!(encode_base64(b"foob", false), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba", false), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar", false), "Zm9vYmFy");

        assert_eq!(decode_base64("Zg==", false), b"f");
        assert_eq!(decode_base64("Zm8=", false), b"fo");
        assert_eq!(decode_base64("Zm9v", false), b"foo");
        assert_eq!(decode_base64("Zm9vYmFy", false), b"foobar");
    }

    #[test]
    fn base64_round_trips_every_tail_length() {
        for length in 0..=64_usize {
            let bytes: Vec<u8> = (0..length).map(|index| index as u8).collect();
            let text = encode_base64(&bytes, false);
            assert_eq!(
                decode_base64(&text, false),
                bytes,
                "standard, {length} bytes"
            );
            let url = encode_base64(&bytes, true);
            assert_eq!(decode_base64(&url, true), bytes, "url-safe, {length} bytes");
        }
    }

    #[test]
    fn base64url_uses_the_other_alphabet_and_no_padding() {
        // 0xff, 0xff -> all six-bit groups have their high bits set, so both of the differing
        // characters appear in one short input.
        assert_eq!(encode_base64(&[0xff, 0xff], false), "//8=");
        assert_eq!(encode_base64(&[0xff, 0xff], true), "__8");
        assert_eq!(encode_base64(&[0xfb, 0xff], false), "+/8=");
        assert_eq!(encode_base64(&[0xfb, 0xff], true), "-_8");
        assert_eq!(encode_base64(&[0xff], true), "_w");

        assert_eq!(decode_base64("-_8", false), vec![0xfb, 0xff]);
        assert_eq!(decode_base64("+/8=", true), vec![0xfb, 0xff]);
        assert_eq!(decode_base64("_w", true), vec![0xff]);
    }

    #[test]
    fn base64_decodes_mixed_alphabets() {
        assert_eq!(decode_base64("+-//", false), vec![0xfb, 0xef, 0xff]);
        assert_eq!(decode_base64("-_+/", false), vec![0xfb, 0xff, 0xbf]);
        // '-' is the URL-safe spelling of '+' and '_' of '/', so these are the same sextets.
        assert_eq!(decode_base64("Z-_g", false), decode_base64("Z+/g", false));
        assert_eq!(decode_base64("Z+/g", false), vec![0x67, 0xef, 0xe0]);
    }

    #[test]
    fn base64_ignores_whitespace_and_other_characters() {
        assert_eq!(decode_base64("Zm9v\n", false), b"foo");
        assert_eq!(decode_base64(" Z m\t9\r\nv ", false), b"foo");
        assert_eq!(decode_base64("Zm!9@v#", false), b"foo");
        assert_eq!(decode_base64("!!!!", false), Vec::<u8>::new());
        // The padding stops decoding; the rest of the string is ignored, valid or not.
        assert_eq!(decode_base64("Zg==Zg==", false), b"f");
        assert_eq!(decode_base64("Zm9v=ZZZ", false), b"foo");
        assert_eq!(decode_base64("=", false), Vec::<u8>::new());
    }

    #[test]
    fn base64_drops_a_lone_trailing_character() {
        assert_eq!(decode_base64("A", false), Vec::<u8>::new());
        assert_eq!(decode_base64("Zg", false), b"f");
        assert_eq!(decode_base64("Zg=", false), b"f");
        assert_eq!(decode_base64("Zm8", false), b"fo");
    }

    #[test]
    fn base64_masks_utf16_code_units_to_bytes() {
        // U+0161 masks to 0x61, the alphabet slot for 'a', so it decodes exactly like "QUaJD".
        assert_eq!(
            decode_base64("QU\u{161}JD", false),
            decode_base64("QUaJD", false)
        );
        // U+0141 masks to 'A'.
        assert_eq!(
            decode_base64("QU\u{141}JD", false),
            decode_base64("QUAJD", false)
        );
        // An astral character is two code units; 0xD83D masks to '=', which stops decoding.
        assert_eq!(decode_base64("QU\u{1f4a9}JD", false), vec![0x41]);
        assert_eq!(
            decode_base64("QU\u{1f4a9}JD", false),
            decode_base64("QU=JD", false)
        );
    }

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(encode_hex(&[0x00, 0x0f, 0x10, 0xff, 0xab]), "000f10ffab");
        assert_eq!(encode_hex(b"Hello"), "48656c6c6f");
    }

    #[test]
    fn hex_decodes_and_drops_an_odd_trailing_digit() {
        assert_eq!(decode_hex("000f10ffab"), vec![0x00, 0x0f, 0x10, 0xff, 0xab]);
        assert_eq!(decode_hex("48656C6C6F"), b"Hello");
        assert_eq!(decode_hex("abc"), vec![0xab]);
        assert_eq!(decode_hex("a"), Vec::<u8>::new());
        assert_eq!(decode_hex("AB"), vec![0xab]);
    }

    #[test]
    fn hex_stops_at_the_first_non_hex_pair() {
        assert_eq!(decode_hex("ab cd"), vec![0xab]);
        assert_eq!(decode_hex("zz"), Vec::<u8>::new());
        assert_eq!(decode_hex("0g"), Vec::<u8>::new());
        assert_eq!(decode_hex("abzzcd"), vec![0xab]);
        // The whole pair is rejected, not just the bad digit: "0g" contributes nothing even
        // though "0" is a valid digit.
        assert_eq!(decode_hex("0g00"), Vec::<u8>::new());
    }

    #[test]
    fn hex_masks_utf16_code_units_to_bytes() {
        // U+0161 masks to 0x61, 'a'; U+0030 is '0'.
        assert_eq!(decode_hex("\u{161}0"), vec![0xa0]);
        assert_eq!(decode_hex("\u{161}0"), decode_hex("a0"));
        // An astral character is two code units; 0xD83D masks to '=' (not hex), so decoding
        // stops there.
        assert_eq!(decode_hex("ab\u{1f4a9}cd"), vec![0xab]);
        assert_eq!(decode_hex("ab\u{1f4a9}cd"), decode_hex("ab"));
    }

    #[test]
    fn hex_round_trips_every_tail_length() {
        for length in 0..=32_usize {
            let bytes: Vec<u8> = (0..length).map(|index| (index * 7) as u8).collect();
            assert_eq!(decode_hex(&encode_hex(&bytes)), bytes, "{length} bytes");
        }
    }
}
