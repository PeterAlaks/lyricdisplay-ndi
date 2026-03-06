use font8x8::{BASIC_FONTS, UnicodeFonts};
use serde_json::Value;

use crate::state::OutputConfig;

#[derive(Debug, Clone)]
pub struct RenderSceneInput {
    pub output_key: String,
    pub config: OutputConfig,
    pub content: Option<Value>,
    pub scene_style: Option<Value>,
    pub media: Option<Value>,
    pub transition: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct RenderFrame {
    pub output_key: String,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub source_name: String,
    pub label_text: String,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Default, Clone)]
pub struct RenderEngine;

impl RenderEngine {
    pub fn new() -> Self {
        Self
    }

    pub fn render_frame(&self, input: &RenderSceneInput) -> RenderFrame {
        let (width, height) = input.config.dimensions();
        let stride = width as usize * 4;
        let source_name = if input.config.source_name.trim().is_empty() {
            format!("LyricDisplay {}", input.output_key)
        } else {
            input.config.source_name.clone()
        };

        let label_text = extract_label_text(input.content.as_ref()).unwrap_or_else(|| {
            format!(
                "LyricDisplay {} ({}x{} @ {}fps)",
                input.output_key,
                width,
                height,
                input.config.normalized_framerate()
            )
        });

        let mut pixels = vec![0_u8; stride * height as usize];
        let visible = input
            .content
            .as_ref()
            .and_then(|content| content.get("visible").and_then(Value::as_bool))
            .unwrap_or(true);

        let base_color = resolve_background_color(input.media.as_ref(), input.scene_style.as_ref(), visible);
        fill_rgba(&mut pixels, width, height, base_color);

        if visible {
            let band = resolve_band_color(input.media.as_ref());
            if band[3] > 0 {
                let band_h = (height / 4).max(60);
                let band_y = height.saturating_sub(band_h + 20);
                draw_rect(&mut pixels, width, height, 0, band_y, width, band_h, band);
            }

            let current_text = input
                .content
                .as_ref()
                .and_then(|content| content.get("currentLine").and_then(Value::as_str))
                .unwrap_or("");
            let previous_text = input
                .content
                .as_ref()
                .and_then(|content| content.get("previousLine").and_then(Value::as_str))
                .unwrap_or("");
            let next_text = input
                .content
                .as_ref()
                .and_then(|content| content.get("nextLine").and_then(Value::as_str))
                .unwrap_or("");

            let main_color = resolve_color(
                input
                    .scene_style
                    .as_ref()
                    .and_then(|style| style.get("fontColor").and_then(Value::as_str)),
                [255, 255, 255, 255],
            );
            let accent_color = resolve_color(
                input
                    .scene_style
                    .as_ref()
                    .and_then(|style| style.get("translationLineColor").and_then(Value::as_str)),
                [251, 191, 36, 255],
            );
            let dim_color = [180, 180, 180, 220];

            // Lightweight transition hint by alpha modulation.
            let transition_alpha = transition_alpha(input.transition.as_ref());
            let main_color = with_alpha(main_color, transition_alpha);
            let accent_color = with_alpha(accent_color, transition_alpha);

            let base_y = height.saturating_sub((height / 4).max(90));
            draw_text_centered(
                &mut pixels,
                width,
                previous_text,
                width as i32 / 2,
                base_y as i32 - 34,
                2,
                dim_color,
            );
            draw_text_centered(
                &mut pixels,
                width,
                current_text,
                width as i32 / 2,
                base_y as i32,
                3,
                main_color,
            );
            draw_text_centered(
                &mut pixels,
                width,
                next_text,
                width as i32 / 2,
                base_y as i32 + 44,
                2,
                accent_color,
            );
        }

        RenderFrame {
            output_key: input.output_key.clone(),
            width,
            height,
            stride,
            source_name,
            label_text,
            pixels,
        }
    }
}

fn extract_label_text(content: Option<&Value>) -> Option<String> {
    let value = content?;

    if let Some(line) = value.get("currentLine").and_then(Value::as_str) {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(line) = value.get("line").and_then(Value::as_str) {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(lines) = value.get("lyrics").and_then(Value::as_array) {
        for entry in lines {
            if let Some(text) = entry.as_str() {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn resolve_background_color(media: Option<&Value>, scene_style: Option<&Value>, visible: bool) -> [u8; 4] {
    if !visible {
        return [0, 0, 0, 0];
    }

    let media_mode = media
        .and_then(|value| value.get("mode").and_then(Value::as_str))
        .unwrap_or("none");

    match media_mode {
        "color" => resolve_color(
            media.and_then(|value| value.get("backgroundColor").and_then(Value::as_str)),
            [0, 0, 0, 255],
        ),
        "image" | "video" => {
            // Placeholder visual for media-backed modes.
            resolve_color(
                media.and_then(|value| value.get("backgroundColor").and_then(Value::as_str)),
                [18, 24, 42, 255],
            )
        }
        _ => resolve_color(
            scene_style.and_then(|value| value.get("backgroundColor").and_then(Value::as_str)),
            [0, 0, 0, 200],
        ),
    }
}

fn resolve_band_color(media: Option<&Value>) -> [u8; 4] {
    let color = resolve_color(
        media
            .and_then(|value| value.get("band"))
            .and_then(|band| band.get("color").and_then(Value::as_str)),
        [0, 0, 0, 255],
    );
    let opacity = media
        .and_then(|value| value.get("band"))
        .and_then(|band| band.get("opacity"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 10.0);
    with_alpha(color, ((opacity / 10.0) * 255.0) as u8)
}

fn resolve_color(value: Option<&str>, fallback: [u8; 4]) -> [u8; 4] {
    let Some(raw) = value else {
        return fallback;
    };

    let hex = raw.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return fallback;
    }

    let parsed = u32::from_str_radix(hex, 16);
    match parsed {
        Ok(color) => [
            ((color >> 16) & 0xff) as u8,
            ((color >> 8) & 0xff) as u8,
            (color & 0xff) as u8,
            fallback[3],
        ],
        Err(_) => fallback,
    }
}

fn transition_alpha(transition: Option<&Value>) -> u8 {
    let transition_type = transition
        .and_then(|value| value.get("type").and_then(Value::as_str))
        .unwrap_or("none");
    let duration_ms = transition
        .and_then(|value| value.get("durationMs").and_then(Value::as_u64))
        .unwrap_or(150)
        .clamp(50, 3000);

    match transition_type {
        "fade" => ((duration_ms as f64 / 3000.0) * 155.0 + 100.0) as u8,
        "blur" => 220,
        "slide" | "wheel" | "scale" => 235,
        _ => 255,
    }
}

fn with_alpha(mut color: [u8; 4], alpha: u8) -> [u8; 4] {
    color[3] = alpha;
    color
}

fn fill_rgba(buffer: &mut [u8], width: u32, height: u32, color: [u8; 4]) {
    for y in 0..height {
        for x in 0..width {
            blend_pixel(buffer, width, x as i32, y as i32, color);
        }
    }
}

fn draw_rect(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    rect_w: u32,
    rect_h: u32,
    color: [u8; 4],
) {
    let max_x = (x + rect_w).min(width);
    let max_y = (y + rect_h).min(height);
    for py in y..max_y {
        for px in x..max_x {
            blend_pixel(buffer, width, px as i32, py as i32, color);
        }
    }
}

fn draw_text_centered(
    buffer: &mut [u8],
    width: u32,
    text: &str,
    center_x: i32,
    y: i32,
    scale: i32,
    color: [u8; 4],
) {
    if text.trim().is_empty() {
        return;
    }

    let max_chars = ((width / (8 * scale as u32)).max(8)).min(96) as usize;
    let mut rendered = text.trim().chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars && max_chars > 3 {
        rendered.truncate(max_chars - 3);
        rendered.push_str("...");
    }

    let text_width = (rendered.chars().count() as i32) * (8 * scale + scale);
    let start_x = center_x - text_width / 2;

    draw_text(buffer, width, start_x, y, &rendered, scale, color);
}

fn draw_text(
    buffer: &mut [u8],
    width: u32,
    x: i32,
    y: i32,
    text: &str,
    scale: i32,
    color: [u8; 4],
) {
    let mut cursor_x = x;
    for ch in text.chars() {
        draw_char(buffer, width, cursor_x, y, ch, scale, color);
        cursor_x += 8 * scale + scale;
    }
}

fn draw_char(
    buffer: &mut [u8],
    width: u32,
    x: i32,
    y: i32,
    ch: char,
    scale: i32,
    color: [u8; 4],
) {
    let Some(bitmap) = BASIC_FONTS.get(ch) else {
        return;
    };

    for (row, bits) in bitmap.iter().enumerate() {
        for col in 0..8_u8 {
            let mask = 1_u8 << col;
            if (*bits & mask) == 0 {
                continue;
            }

            let px = x + col as i32 * scale;
            let py = y + row as i32 * scale;

            for sy in 0..scale {
                for sx in 0..scale {
                    blend_pixel(buffer, width, px + sx, py + sy, color);
                }
            }
        }
    }
}

fn blend_pixel(buffer: &mut [u8], width: u32, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 {
        return;
    }

    let x = x as u32;
    let y = y as u32;
    let height = (buffer.len() / 4) as u32 / width;
    if x >= width || y >= height {
        return;
    }

    let idx = ((y * width + x) * 4) as usize;
    let dst_r = buffer[idx] as f32;
    let dst_g = buffer[idx + 1] as f32;
    let dst_b = buffer[idx + 2] as f32;
    let dst_a = buffer[idx + 3] as f32 / 255.0;

    let src_a = color[3] as f32 / 255.0;
    let out_a = src_a + dst_a * (1.0 - src_a);
    if out_a <= 0.0 {
        return;
    }

    let src_r = color[0] as f32;
    let src_g = color[1] as f32;
    let src_b = color[2] as f32;

    let out_r = (src_r * src_a + dst_r * dst_a * (1.0 - src_a)) / out_a;
    let out_g = (src_g * src_a + dst_g * dst_a * (1.0 - src_a)) / out_a;
    let out_b = (src_b * src_a + dst_b * dst_a * (1.0 - src_a)) / out_a;

    buffer[idx] = out_r.clamp(0.0, 255.0) as u8;
    buffer[idx + 1] = out_g.clamp(0.0, 255.0) as u8;
    buffer[idx + 2] = out_b.clamp(0.0, 255.0) as u8;
    buffer[idx + 3] = (out_a * 255.0).clamp(0.0, 255.0) as u8;
}
