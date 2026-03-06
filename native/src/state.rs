use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

const MAX_FRAME_TIME_SAMPLES: usize = 180;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_resolution")]
    pub resolution: String,
    #[serde(alias = "customWidth")]
    #[serde(default = "default_width")]
    pub custom_width: u32,
    #[serde(alias = "customHeight")]
    #[serde(default = "default_height")]
    pub custom_height: u32,
    #[serde(default = "default_framerate")]
    pub framerate: u32,
    #[serde(alias = "sourceName")]
    #[serde(default)]
    pub source_name: String,
}

fn default_resolution() -> String {
    "1080p".to_string()
}

fn default_width() -> u32 {
    1920
}

fn default_height() -> u32 {
    1080
}

fn default_framerate() -> u32 {
    30
}

impl OutputConfig {
    pub fn with_defaults(output_key: &str) -> Self {
        Self {
            enabled: false,
            resolution: default_resolution(),
            custom_width: default_width(),
            custom_height: default_height(),
            framerate: default_framerate(),
            source_name: default_source_name(output_key),
        }
    }

    pub fn normalized_framerate(&self) -> u32 {
        self.framerate.clamp(1, 60)
    }

    pub fn dimensions(&self) -> (u32, u32) {
        match self.resolution.as_str() {
            "720p" => (1280, 720),
            "1080p" => (1920, 1080),
            "1440p" => (2560, 1440),
            "4k" | "2160p" => (3840, 2160),
            "custom" => (
                self.custom_width.clamp(320, 7680),
                self.custom_height.clamp(240, 4320),
            ),
            _ => (1920, 1080),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputRuntimeStats {
    pub backend: String,
    pub enabled: bool,
    pub target_fps: u32,
    pub width: u32,
    pub height: u32,
    pub source_name: String,
    pub frames_rendered: u64,
    pub frames_sent: u64,
    pub dropped_frames: u64,
    pub send_failures: u64,
    pub render_fps: f64,
    pub send_fps: f64,
    pub avg_frame_ms: f64,
    pub p95_frame_ms: f64,
    pub last_frame_ms: f64,
    pub queue_depth: u32,
    #[serde(skip_serializing)]
    frame_time_samples: VecDeque<f64>,
    #[serde(skip_serializing)]
    window_started_at: Instant,
    #[serde(skip_serializing)]
    window_rendered: u64,
    #[serde(skip_serializing)]
    window_sent: u64,
}

impl OutputRuntimeStats {
    pub fn new(config: &OutputConfig) -> Self {
        let (width, height) = config.dimensions();
        Self {
            backend: "mock".to_string(),
            enabled: config.enabled,
            target_fps: config.normalized_framerate(),
            width,
            height,
            source_name: config.source_name.clone(),
            frames_rendered: 0,
            frames_sent: 0,
            dropped_frames: 0,
            send_failures: 0,
            render_fps: 0.0,
            send_fps: 0.0,
            avg_frame_ms: 0.0,
            p95_frame_ms: 0.0,
            last_frame_ms: 0.0,
            queue_depth: 0,
            frame_time_samples: VecDeque::with_capacity(MAX_FRAME_TIME_SAMPLES),
            window_started_at: Instant::now(),
            window_rendered: 0,
            window_sent: 0,
        }
    }

    pub fn refresh_config(&mut self, config: &OutputConfig) {
        let (width, height) = config.dimensions();
        self.enabled = config.enabled;
        self.target_fps = config.normalized_framerate();
        self.width = width;
        self.height = height;
        self.source_name = config.source_name.clone();
    }

    pub fn record_frame(
        &mut self,
        render_ms: f64,
        send_succeeded: bool,
        send_failed: bool,
        dropped: bool,
        queue_depth: u32,
        backend: &str,
    ) {
        self.frames_rendered += 1;
        self.window_rendered += 1;
        self.last_frame_ms = render_ms;

        if send_succeeded {
            self.frames_sent += 1;
            self.window_sent += 1;
        }

        if send_failed {
            self.send_failures += 1;
        }

        if dropped {
            self.dropped_frames += 1;
        }
        self.queue_depth = queue_depth;
        self.backend = backend.to_string();

        self.frame_time_samples.push_back(render_ms);
        if self.frame_time_samples.len() > MAX_FRAME_TIME_SAMPLES {
            let _ = self.frame_time_samples.pop_front();
        }

        self.avg_frame_ms = if self.frame_time_samples.is_empty() {
            0.0
        } else {
            self.frame_time_samples.iter().sum::<f64>() / self.frame_time_samples.len() as f64
        };

        if !self.frame_time_samples.is_empty() {
            let mut sorted = self.frame_time_samples.iter().copied().collect::<Vec<f64>>();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let percentile_index = ((sorted.len() - 1) as f64 * 0.95).round() as usize;
            self.p95_frame_ms = sorted[percentile_index];
        }

        let elapsed = self.window_started_at.elapsed().as_secs_f64();
        if elapsed >= 1.0 {
            self.render_fps = self.window_rendered as f64 / elapsed;
            self.send_fps = self.window_sent as f64 / elapsed;
            self.window_started_at = Instant::now();
            self.window_rendered = 0;
            self.window_sent = 0;
        }
    }
}

#[derive(Debug)]
pub struct RuntimeState {
    pub started_at: Instant,
    pub outputs: HashMap<String, OutputConfig>,
    pub scene_styles: HashMap<String, Value>,
    pub contents: HashMap<String, Value>,
    pub media: HashMap<String, Value>,
    pub transitions: HashMap<String, Value>,
    pub last_seq: u64,
    pub output_stats: HashMap<String, OutputRuntimeStats>,
}

impl RuntimeState {
    pub fn new() -> Self {
        let mut outputs = HashMap::new();
        outputs.insert("output1".to_string(), OutputConfig::with_defaults("output1"));
        outputs.insert("output2".to_string(), OutputConfig::with_defaults("output2"));
        outputs.insert("stage".to_string(), OutputConfig::with_defaults("stage"));

        let mut output_stats = HashMap::new();
        output_stats.insert(
            "output1".to_string(),
            OutputRuntimeStats::new(outputs.get("output1").expect("output1 exists")),
        );
        output_stats.insert(
            "output2".to_string(),
            OutputRuntimeStats::new(outputs.get("output2").expect("output2 exists")),
        );
        output_stats.insert(
            "stage".to_string(),
            OutputRuntimeStats::new(outputs.get("stage").expect("stage exists")),
        );

        Self {
            started_at: Instant::now(),
            outputs,
            scene_styles: HashMap::new(),
            contents: HashMap::new(),
            media: HashMap::new(),
            transitions: HashMap::new(),
            last_seq: 0,
            output_stats,
        }
    }

    pub fn mark_seq(&mut self, seq: Option<u64>) {
        if let Some(seq_value) = seq {
            self.last_seq = self.last_seq.max(seq_value);
        }
    }

    pub fn apply_outputs_from_payload(&mut self, payload: &Value) -> usize {
        let mut changed = 0;
        let Some(outputs_value) = payload.get("outputs") else {
            return changed;
        };

        let Some(outputs_map) = outputs_value.as_object() else {
            return changed;
        };

        for (key, value) in outputs_map {
            if let Ok(mut config) = serde_json::from_value::<OutputConfig>(value.clone()) {
                if config.source_name.trim().is_empty() {
                    config.source_name = default_source_name(key);
                }
                self.outputs.insert(key.to_string(), config.clone());
                self.sync_output_stats(key, &config);
                changed += 1;
            }
        }

        changed
    }

    pub fn enabled_output_configs(&self) -> HashMap<String, OutputConfig> {
        self.outputs
            .iter()
            .filter(|(_, config)| config.enabled)
            .map(|(key, config)| (key.clone(), config.clone()))
            .collect()
    }

    pub fn record_output_frame(
        &mut self,
        output_key: &str,
        render_ms: f64,
        send_succeeded: bool,
        send_failed: bool,
        dropped: bool,
        queue_depth: u32,
        backend: &str,
    ) {
        let config = self
            .outputs
            .get(output_key)
            .cloned()
            .unwrap_or_else(|| OutputConfig::with_defaults(output_key));

        let stats = self
            .output_stats
            .entry(output_key.to_string())
            .or_insert_with(|| OutputRuntimeStats::new(&config));
        stats.refresh_config(&config);
        stats.record_frame(
            render_ms,
            send_succeeded,
            send_failed,
            dropped,
            queue_depth,
            backend,
        );
    }

    fn sync_output_stats(&mut self, output_key: &str, config: &OutputConfig) {
        let stats = self
            .output_stats
            .entry(output_key.to_string())
            .or_insert_with(|| OutputRuntimeStats::new(config));
        stats.refresh_config(config);
    }
}

pub type SharedState = Arc<RwLock<RuntimeState>>;

fn default_source_name(output_key: &str) -> String {
    match output_key {
        "output1" => "LyricDisplay Output 1".to_string(),
        "output2" => "LyricDisplay Output 2".to_string(),
        "stage" => "LyricDisplay Stage".to_string(),
        other => format!("LyricDisplay {other}"),
    }
}
