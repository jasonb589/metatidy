//! 封面缩略图的纯图像处理。只产生缓存字节，不写音频标签或改变原始封面。
//!
//! AVIF 使用纯 Rust rav1e 编码器；关闭 image 的默认格式、rayon、nasm 特性，
//! 避免在 ARM 交叉编译时引入系统库或每个缩略图占满所有 CPU。

use std::io::Cursor;

use anyhow::{bail, ensure, Context};
use image::codecs::avif::AvifEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};

pub const MAX_THUMB_EDGE: u32 = 512;
const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SOURCE_EDGE: u32 = 8192;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const AVIF_SPEED: u8 = 8;
const AVIF_QUALITY: u8 = 60;

/// 保持比例、不放大，生成最长边不超过 `edge` 的真正 AVIF。
///
/// 调用方应在受并发限制的阻塞任务中运行本函数。动画封面使用首帧；
/// JPEG/PNG/WebP/GIF 可作为来源，EXIF 方向在缩小后应用，避免旋转大图额外分配。
pub fn encode_thumbnail(bytes: &[u8], edge: u32) -> anyhow::Result<Vec<u8>> {
    ensure!(
        (1..=MAX_THUMB_EDGE).contains(&edge),
        "缩略图尺寸必须在 1–{MAX_THUMB_EDGE} 像素之间"
    );
    let image = decode_thumbnail(bytes, edge)?;
    let mut output = Vec::new();
    let encoder = AvifEncoder::new_with_speed_quality(&mut output, AVIF_SPEED, AVIF_QUALITY)
        .with_num_threads(Some(1));
    if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        encoder
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .context("AVIF 透明缩略图编码失败")?;
    } else {
        let rgb = image.to_rgb8();
        encoder
            .write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .context("AVIF 缩略图编码失败")?;
    }
    Ok(output)
}

fn decode_thumbnail(bytes: &[u8], edge: u32) -> anyhow::Result<DynamicImage> {
    ensure!(!bytes.is_empty(), "封面为空");
    ensure!(
        bytes.len() <= MAX_SOURCE_BYTES,
        "封面超过 32 MiB，跳过缩略图生成"
    );
    let format = image::guess_format(bytes).context("无法识别封面图片格式")?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif
    ) {
        bail!("暂不支持将 {format:?} 封面转换为缩略图");
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_EDGE);
    limits.max_image_height = Some(MAX_SOURCE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .context("封面图片头无效或超过尺寸限制")?;
    let (width, height) = decoder.dimensions();
    ensure!(width > 0 && height > 0, "封面尺寸为零");
    // 与 ImageReader::decode 相同，先为输出像素预算，再把余量交给解码器。
    limits
        .reserve(decoder.total_bytes())
        .context("封面解码内存超过 128 MiB 限制")?;
    decoder.set_limits(limits).context("封面解码资源超过限制")?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let image = DynamicImage::from_decoder(decoder).context("封面图片解码失败")?;
    let mut thumbnail = if width > edge || height > edge {
        image.resize(edge, edge, FilterType::Lanczos3)
    } else {
        image
    };
    thumbnail.apply_orientation(orientation);
    Ok(thumbnail)
}

/// Navidrome's native upload supports JPEG; keep its upload artifact separate
/// from the AVIF preview. Decode once with the existing resource limits.
pub fn encode_portrait(bytes: &[u8]) -> anyhow::Result<(Vec<u8>, Vec<u8>, u32, u32)> {
    let portrait = decode_thumbnail(bytes, 1024)?;
    let (width, height) = (portrait.width(), portrait.height());
    let rgba = portrait.to_rgba8();
    let rgb = image::RgbImage::from_fn(width, height, |x, y| {
        let pixel = rgba.get_pixel(x, y);
        let alpha = u32::from(pixel[3]);
        image::Rgb(std::array::from_fn(|channel| {
            ((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        }))
    });
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&DynamicImage::ImageRgb8(rgb))?;
    let preview = encode_thumbnail(&jpeg, 512)?;
    Ok((jpeg, preview, width, height))
}

/// 原图按实际字节确定 MIME，不依赖旧缓存的 `.jpg` 扩展名或不可靠标签 MIME。
pub fn detected_mime(bytes: &[u8]) -> Option<&'static str> {
    // image 的 AVIF 猜测只覆盖主要品牌；也接纳 ftyp 中合法的兼容品牌。
    if is_avif(bytes) {
        return Some("image/avif");
    }
    match image::guess_format(bytes).ok()? {
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::WebP => Some("image/webp"),
        ImageFormat::Bmp => Some("image/bmp"),
        ImageFormat::Tiff => Some("image/tiff"),
        _ => None,
    }
}

fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || bytes.get(4..8) != Some(b"ftyp") {
        return false;
    }
    let size = u32::from_be_bytes(bytes[..4].try_into().expect("length checked")) as usize;
    if size < 16 || size > bytes.len() || size % 4 != 0 {
        return false;
    }
    let is_brand = |brand: &[u8]| brand == b"avif" || brand == b"avis";
    is_brand(&bytes[8..12]) || bytes[16..size].chunks_exact(4).any(is_brand)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
            Rgb([(x % 255) as u8, (y % 255) as u8, 100])
        }));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    // Traverse actual BMFF boxes, not an arbitrary byte match inside the AV1 payload.
    fn avif_sizes(bytes: &[u8]) -> Vec<(u32, u32)> {
        fn walk(mut data: &[u8], sizes: &mut Vec<(u32, u32)>) {
            while data.len() >= 8 {
                let size = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
                assert!(size >= 8 && size <= data.len(), "invalid BMFF box");
                let payload = &data[8..size];
                match &data[4..8] {
                    b"meta" => walk(&payload[4..], sizes),
                    b"iprp" | b"ipco" => walk(payload, sizes),
                    b"ispe" => {
                        assert_eq!(payload.len(), 12);
                        sizes.push((
                            u32::from_be_bytes(payload[4..8].try_into().unwrap()),
                            u32::from_be_bytes(payload[8..12].try_into().unwrap()),
                        ));
                    }
                    _ => {}
                }
                data = &data[size..];
            }
            assert!(data.is_empty());
        }
        let mut sizes = Vec::new();
        walk(bytes, &mut sizes);
        sizes
    }

    #[test]
    fn avif_is_a_real_resized_image_with_preserved_aspect() {
        let original = png(640, 320);
        let encoded = encode_thumbnail(&original, 128).unwrap();
        assert_eq!(detected_mime(&encoded), Some("image/avif"));
        assert!(!encoded.starts_with(b"\x89PNG"));
        let sizes = avif_sizes(&encoded);
        assert!(!sizes.is_empty());
        assert!(sizes.iter().all(|&size| size == (128, 64)), "{sizes:?}");
    }

    #[test]
    fn small_images_are_not_upscaled() {
        let encoded = encode_thumbnail(&png(24, 36), 128).unwrap();
        let sizes = avif_sizes(&encoded);
        assert!(!sizes.is_empty());
        assert!(sizes.iter().all(|&size| size == (24, 36)), "{sizes:?}");
    }

    #[test]
    fn portrait_upload_and_preview_keep_aspect_and_flatten_alpha() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(1600, 800, |x, _| {
            Rgba([30, 90, 160, if x < 800 { 0 } else { 255 }])
        }));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let (jpeg, avif, width, height) = encode_portrait(bytes.get_ref()).unwrap();
        assert_eq!((width, height), (1024, 512));
        assert_eq!(detected_mime(&jpeg), Some("image/jpeg"));
        let uploaded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(uploaded.dimensions(), (1024, 512));
        assert!(uploaded
            .get_pixel(0, 0)
            .0
            .iter()
            .all(|channel| *channel >= 253));
        assert_eq!(detected_mime(&avif), Some("image/avif"));
        assert_eq!(avif_sizes(&avif), vec![(512, 256)]);
        assert!(encode_portrait(b"not a portrait").is_err());
    }

    #[test]
    fn transparency_survives_resize_and_is_encoded_as_avif_alpha() {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_fn(32, 16, |x, _| {
            Rgba([90, 150, 70, if x < 16 { 0 } else { 255 }])
        }));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let thumb = decode_thumbnail(bytes.get_ref(), 16).unwrap().to_rgba8();
        assert_eq!(thumb.dimensions(), (16, 8));
        assert_eq!(thumb.get_pixel(0, 0).0[3], 0);
        assert_eq!(thumb.get_pixel(15, 0).0[3], 255);
        let encoded = encode_thumbnail(bytes.get_ref(), 16).unwrap();
        // Alpha uses the standardized auxiliary image property, not an opaque RGB conversion.
        assert!(encoded
            .windows(b"urn:mpeg:mpegB:cicp:systems:auxiliary:alpha".len())
            .any(|window| window == b"urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"));
        assert!(avif_sizes(&encoded).iter().all(|&size| size == (16, 8)));
    }

    #[test]
    fn malformed_and_unbounded_inputs_fail_without_encoding() {
        assert!(encode_thumbnail(&[], 128).is_err());
        assert!(encode_thumbnail(b"not an image", 128).is_err());
        assert!(encode_thumbnail(b"\x89PNG\r\n\x1a\n", 128).is_err());
        assert!(encode_thumbnail(&png(8, 8), 0).is_err());
        assert!(encode_thumbnail(&png(8, 8), MAX_THUMB_EDGE + 1).is_err());
        // A valid, tiny file with excessive dimensions is rejected before pixel decoding.
        assert!(encode_thumbnail(&png(MAX_SOURCE_EDGE + 1, 1), 128).is_err());
    }

    #[test]
    fn mime_detection_uses_content_and_handles_avif_compatible_brands() {
        assert_eq!(detected_mime(&png(1, 1)), Some("image/png"));
        assert_eq!(detected_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(detected_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(detected_mime(b"RIFF\x10\0\0\0WEBP"), Some("image/webp"));
        assert_eq!(
            detected_mime(b"\0\0\0\x18ftypmif1\0\0\0\0avifmiaf"),
            Some("image/avif")
        );
        assert_eq!(detected_mime(b"\0\0\0\x18ftypmif1avifheicmiaf"), None);
        assert_eq!(detected_mime(b"\0\0\0\x28ftypavif\0\0\0\0"), None);
        assert_eq!(detected_mime(b"cover.jpg"), None);
    }
}
