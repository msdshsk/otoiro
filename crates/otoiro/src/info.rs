//! Tags and cover art, read without starting playback.

use std::fs::File;
use std::path::Path;

use serde::Serialize;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTag, StandardVisualKey, Visual};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub bpm: Option<u64>,
    pub key: Option<String>,
    pub duration: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<usize>,
    /// MIME type of the embedded cover, if there is one. Fetch the bytes with [`cover_art`].
    pub cover_type: Option<String>,
}

pub struct CoverArt {
    pub media_type: Option<String>,
    pub data: Vec<u8>,
}

pub(crate) fn open_format(path: &str) -> Result<Box<dyn FormatReader>, String> {
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("unsupported format: {e}"))
}

/// Duration in seconds from the container, if it declares one.
pub(crate) fn track_duration(format: &dyn FormatReader) -> Option<f64> {
    let track = format.default_track(TrackType::Audio)?;
    let rate = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .and_then(|a| a.sample_rate);
    match (track.time_base, track.duration) {
        (Some(tb), Some(d)) => tb.calc_duration(d).map(|t| t.as_secs_f64()),
        _ => None,
    }
    .or_else(|| Some(track.num_frames? as f64 / rate? as f64))
}

/// Every metadata revision the demuxer has seen (leading ID3v2, container tags, ...),
/// oldest first.
fn revisions(format: &mut dyn FormatReader) -> Vec<MetadataRevision> {
    let mut metadata = format.metadata();
    let mut revs = Vec::new();
    while let Some(rev) = metadata.pop() {
        revs.push(rev);
    }
    if let Some(cur) = metadata.current() {
        revs.push(cur.clone());
    }
    revs
}

pub fn media_info(path: &str) -> Result<MediaInfo, String> {
    let mut format = open_format(path)?;
    let mut info = MediaInfo {
        duration: track_duration(format.as_ref()),
        ..Default::default()
    };
    if let Some(params) = format
        .default_track(TrackType::Audio)
        .and_then(|t| t.codec_params.as_ref())
        .and_then(|p| p.audio())
    {
        info.sample_rate = params.sample_rate;
        info.channels = params.channels.as_ref().map(|c| c.count());
    }

    let revs = revisions(format.as_mut());
    for rev in &revs {
        let tracks = rev.per_track.iter().map(|t| &t.metadata);
        for container in std::iter::once(&rev.media).chain(tracks) {
            for tag in &container.tags {
                let Some(std) = &tag.std else { continue };
                // Later revisions win, which matches how players usually resolve duplicates.
                match std {
                    StandardTag::TrackTitle(v) => info.title = text(v),
                    StandardTag::Artist(v) => info.artist = text(v),
                    StandardTag::Album(v) => info.album = text(v),
                    StandardTag::AlbumArtist(v) => info.album_artist = text(v),
                    StandardTag::Genre(v) => info.genre = text(v),
                    StandardTag::RecordingDate(v) | StandardTag::ReleaseDate(v) => {
                        info.year.get_or_insert_with(|| v.trim().to_string());
                    }
                    StandardTag::RecordingYear(y) | StandardTag::ReleaseYear(y) => {
                        info.year.get_or_insert_with(|| y.to_string());
                    }
                    StandardTag::Bpm(v) => info.bpm = Some(*v),
                    StandardTag::InitialKey(v) => info.key = text(v),
                    _ => {}
                }
            }
        }
    }
    info.cover_type = pick_cover(&revs).map(|v| v.media_type.clone().unwrap_or_default());
    Ok(info)
}

pub fn cover_art(path: &str) -> Result<Option<CoverArt>, String> {
    let mut format = open_format(path)?;
    let revs = revisions(format.as_mut());
    Ok(pick_cover(&revs).map(|v| CoverArt {
        media_type: v.media_type.clone(),
        data: v.data.to_vec(),
    }))
}

/// Cleans up a tag value: trims the padding of fixed-width fields (ID3v1) and repairs legacy
/// Japanese text. ID3v1 and many old ID3v2 tags hold Shift_JIS bytes in fields that are
/// declared (or assumed) Latin-1, which decode as mojibake. Such a string maps back to its
/// original bytes one char per byte, so it is re-decoded as Shift_JIS when that yields valid
/// text containing Japanese characters.
fn text(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(|c: char| c.is_whitespace() || c == '\0');
    if trimmed.is_empty() {
        return None;
    }
    let latin1 = trimmed.chars().all(|c| (c as u32) <= 0xFF);
    let high = trimmed.chars().any(|c| (c as u32) >= 0x80);
    if latin1 && high {
        let bytes: Vec<u8> = trimmed.chars().map(|c| c as u8).collect();
        if let Some(decoded) =
            encoding_rs::SHIFT_JIS.decode_without_bom_handling_and_without_replacement(&bytes)
        {
            if decoded.chars().any(is_japanese) {
                return Some(decoded.trim().to_string());
            }
        }
    }
    Some(trimmed.to_string())
}

fn is_japanese(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF       // hiragana, katakana
        | 0x3400..=0x4DBF     // CJK extension A
        | 0x4E00..=0x9FFF     // CJK unified ideographs
        | 0xFF66..=0xFF9F     // half-width katakana
    )
}

/// Front cover if tagged as such, otherwise the first picture.
fn pick_cover(revs: &[MetadataRevision]) -> Option<&Visual> {
    let visuals = || revs.iter().rev().flat_map(|r| r.media.visuals.iter());
    visuals()
        .find(|v| v.usage == Some(StandardVisualKey::FrontCover))
        .or_else(|| visuals().next())
}

#[cfg(test)]
mod tests {
    use super::text;

    /// Shift_JIS bytes read as Latin-1, the way an ID3v1 title arrives.
    fn as_latin1(bytes: &[u8]) -> String {
        bytes.iter().map(|&b| b as char).collect()
    }

    #[test]
    fn repairs_shift_jis_read_as_latin1() {
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("ダイナマイトが5万トン");
        let padded = format!("{}         ", as_latin1(&sjis));
        assert_eq!(text(&padded).as_deref(), Some("ダイナマイトが5万トン"));
    }

    #[test]
    fn keeps_real_latin1_and_ascii() {
        assert_eq!(text("Beyoncé").as_deref(), Some("Beyoncé"));
        assert_eq!(
            text("PURE SONG and PICTURES        ").as_deref(),
            Some("PURE SONG and PICTURES")
        );
        assert_eq!(text("   "), None);
    }
}
