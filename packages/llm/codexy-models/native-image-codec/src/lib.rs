// SPDX-License-Identifier: Apache-2.0
// Product-owned HIGH_DETAIL image preparation, adapted from OpenAI Codex rust-v0.162.1.
// Modified to expose a bounded, host-independent WASM ABI; no agent or platform runtime.
// Source: https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/utils/image/src/lib.rs
use std::io::Cursor;
use image::{ColorType, DynamicImage, GenericImageView, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use image::codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder};
use image::imageops::FilterType;

pub struct Prepared {
    pub data: Vec<u8>,
    pub mime: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub width: u32,
    pub height: u32,
}
fn fits(width: u32, height: u32) -> bool {
    width <= 2048 && height <= 2048
        && u64::from(width.div_ceil(32)) * u64::from(height.div_ceil(32)) <= 2500
}
pub fn dimensions(width: u32, height: u32) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    if fits(width, height) { return (width, height); }
    let scale = (2048.0 / f64::from(width.max(height))).min(1.0);
    let width = ((f64::from(width) * scale).round() as u32).max(1);
    let height = ((f64::from(height) * scale).round() as u32).max(1);
    if fits(width, height) { return (width, height); }
    let width_f64 = f64::from(width);
    let height_f64 = f64::from(height);
    let mut scale = (32.0 * 32.0 * 2500.0 / width_f64 / height_f64).sqrt();
    let columns = width_f64 * scale / 32.0;
    let rows = height_f64 * scale / 32.0;
    scale *= (columns.floor() / columns).min(rows.floor() / rows);
    (((width_f64 * scale).floor() as u32).max(1), ((height_f64 * scale).floor() as u32).max(1))
}
fn apply_metadata(encoder: &mut impl ImageEncoder, icc: Option<Vec<u8>>, exif: Option<Vec<u8>>) -> Result<(), String> {
    if let Some(icc) = icc { encoder.set_icc_profile(icc).map_err(|e| e.to_string())?; }
    if let Some(exif) = exif { encoder.set_exif_metadata(exif).map_err(|e| e.to_string())?; }
    Ok(())
}
fn encode(image: &DynamicImage, format: ImageFormat, icc: Option<Vec<u8>>, exif: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    match format {
        ImageFormat::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(&mut output, 85);
            apply_metadata(&mut encoder, icc, exif)?;
            encoder.encode_image(image).map_err(|e| e.to_string())?;
        }
        ImageFormat::WebP => {
            let rgba = image.to_rgba8();
            let mut encoder = WebPEncoder::new_lossless(&mut output);
            apply_metadata(&mut encoder, icc, exif)?;
            encoder.write_image(rgba.as_raw(), image.width(), image.height(), ColorType::Rgba8.into()).map_err(|e| e.to_string())?;
        }
        _ => {
            let rgba = image.to_rgba8();
            let mut encoder = PngEncoder::new(&mut output);
            apply_metadata(&mut encoder, icc, exif)?;
            encoder.write_image(rgba.as_raw(), image.width(), image.height(), ColorType::Rgba8.into()).map_err(|e| e.to_string())?;
        }
    }
    Ok(output)
}
pub fn prepare(data: &[u8], max_bytes: usize, max_pixels: u64, max_dimension: u32) -> Result<Prepared, String> {
    if data.is_empty() || data.len() > max_bytes { return Err("source byte limit exceeded".into()); }
    let format = image::guess_format(data).map_err(|e| e.to_string())?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) { return Err("unsupported source image format".into()); }
    let mut decoder = ImageReader::with_format(Cursor::new(data), format).into_decoder().map_err(|e| e.to_string())?;
    let (source_width, source_height) = decoder.dimensions();
    if source_width > max_dimension || source_height > max_dimension || u64::from(source_width) * u64::from(source_height) > max_pixels { return Err("source dimensions or pixel limit exceeded".into()); }
    let icc = decoder.icc_profile().ok().flatten().filter(|v| v.get(16..20) == Some(b"RGB "));
    let exif = decoder.exif_metadata().ok().flatten();
    let dynamic = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    let (source_width, source_height) = dynamic.dimensions();
    let (width, height) = dimensions(source_width, source_height);
    let output_format = if format == ImageFormat::Gif { ImageFormat::Png } else { format };
    let bytes = if (width, height) == (source_width, source_height) && format != ImageFormat::Gif { data.to_vec() }
        else {
            let prepared = if (width, height) == (source_width, source_height) { dynamic }
                else { dynamic.resize_exact(width, height, FilterType::Triangle) };
            encode(&prepared, output_format, icc, exif)?
        };
    Ok(Prepared { data: bytes, mime: match output_format { ImageFormat::Jpeg => 2, ImageFormat::WebP => 3, _ => 1 }, source_width, source_height, width, height })
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    #[repr(C)]
    struct Descriptor { data: u32, len: u32, mime: u32, source_width: u32, source_height: u32, width: u32, height: u32, error: u32 }
    #[unsafe(no_mangle)]
    pub extern "C" fn allocate_input(len: u32) -> u32 { Box::into_raw(vec![0u8; len as usize].into_boxed_slice()) as *mut u8 as u32 }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn release_input(ptr: u32, len: u32) {
        unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as *mut u8, len as usize))); }
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn prepare_image(ptr: u32, len: u32, max_bytes: u32, max_pixels: u32, max_dimension: u32) -> u32 {
        let source = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
        let (prepared, error) = match prepare(source, max_bytes as usize, max_pixels as u64, max_dimension) {
            Ok(value) => (value, 0),
            Err(error) => (Prepared { data: error.into_bytes(), mime: 0, source_width: 0, source_height: 0, width: 0, height: 0 }, 1),
        };
        let len = prepared.data.len() as u32;
        let data = Box::into_raw(prepared.data.into_boxed_slice()) as *mut u8 as u32;
        Box::into_raw(Box::new(Descriptor { data, len, mime: prepared.mime, source_width: prepared.source_width, source_height: prepared.source_height, width: prepared.width, height: prepared.height, error })) as u32
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn release_result(ptr: u32) {
        let descriptor = unsafe { Box::from_raw(ptr as *mut Descriptor) };
        unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(descriptor.data as *mut u8, descriptor.len as usize))); }
    }
}
