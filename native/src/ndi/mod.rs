mod native_sender;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::render::{RenderEngine, RenderFrame, RenderSceneInput};
use crate::state::{OutputConfig, SharedState};
use native_sender::NativeNdiSender;

const NATIVE_RETRY_BASE_SECS: u64 = 5;
const NATIVE_RETRY_MAX_SECS: u64 = 60;

#[derive(Debug)]
struct MockNdiSender {
    source_name: String,
    last_signature: u64,
}

impl MockNdiSender {
    fn new(source_name: &str) -> Self {
        Self {
            source_name: source_name.to_string(),
            last_signature: 0,
        }
    }

    fn send_frame(&mut self, frame: &RenderFrame) -> bool {
        if frame.width == 0 || frame.height == 0 {
            return false;
        }

        if self.source_name.trim().is_empty() || frame.source_name.trim().is_empty() {
            return false;
        }

        if frame.pixels.is_empty() || frame.stride == 0 {
            return false;
        }

        // Lightweight content signature so mock sender still reflects changing frames.
        // This allows telemetry/testing to verify frame progression without NDI SDK yet.
        let mut signature = frame.width as u64 ^ (frame.height as u64) << 16;
        signature ^= frame.output_key.len() as u64;
        signature ^= frame.label_text.len() as u64;
        for byte in frame.pixels.iter().step_by(4096).take(64) {
            signature = signature.rotate_left(5) ^ (*byte as u64);
        }
        self.last_signature = signature;

        true
    }
}

enum SenderBackend {
    Native(NativeNdiSender),
    Mock(MockNdiSender),
}

impl SenderBackend {
    fn backend_name(&self) -> &'static str {
        match self {
            Self::Native(_) => "native",
            Self::Mock(_) => "mock",
        }
    }

    fn send_frame(&mut self, frame: &RenderFrame) -> Result<(), String> {
        match self {
            Self::Native(sender) => sender.send_frame(frame),
            Self::Mock(sender) => {
                if sender.send_frame(frame) {
                    Ok(())
                } else {
                    Err("mock sender rejected frame".to_string())
                }
            }
        }
    }
}

#[derive(Debug)]
struct OutputWorkerHandle {
    config: OutputConfig,
    shutdown_tx: watch::Sender<bool>,
    join_handle: JoinHandle<()>,
}

#[derive(Debug, Default)]
struct NdiManagerInner {
    workers: HashMap<String, OutputWorkerHandle>,
}

#[derive(Debug, Clone)]
pub struct NdiOutputManager {
    state: SharedState,
    renderer: RenderEngine,
    inner: Arc<Mutex<NdiManagerInner>>,
}

impl NdiOutputManager {
    pub fn new(state: SharedState) -> Self {
        Self {
            state,
            renderer: RenderEngine::new(),
            inner: Arc::new(Mutex::new(NdiManagerInner::default())),
        }
    }

    pub async fn reconcile_outputs(&self, desired_outputs: HashMap<String, OutputConfig>) -> usize {
        let mut handles_to_stop: Vec<OutputWorkerHandle> = Vec::new();

        {
            let mut guard = self.inner.lock().await;

            let existing_keys = guard.workers.keys().cloned().collect::<Vec<String>>();
            for key in existing_keys {
                let should_remove = match desired_outputs.get(&key) {
                    Some(config) => guard
                        .workers
                        .get(&key)
                        .map(|existing| existing.config != *config)
                        .unwrap_or(true),
                    None => true,
                };

                if should_remove {
                    if let Some(removed) = guard.workers.remove(&key) {
                        handles_to_stop.push(removed);
                    }
                }
            }
        }

        for handle in handles_to_stop {
            stop_worker(handle).await;
        }

        {
            let mut guard = self.inner.lock().await;
            for (key, config) in desired_outputs {
                if guard.workers.contains_key(&key) {
                    continue;
                }

                let worker = spawn_output_worker(
                    key.clone(),
                    config.clone(),
                    self.state.clone(),
                    self.renderer.clone(),
                );
                guard.workers.insert(key, worker);
            }

            guard.workers.len()
        }
    }

    pub async fn shutdown_all(&self) {
        let handles_to_stop: Vec<OutputWorkerHandle> = {
            let mut guard = self.inner.lock().await;
            guard.workers.drain().map(|(_, worker)| worker).collect()
        };

        for handle in handles_to_stop {
            stop_worker(handle).await;
        }
    }
}

fn spawn_output_worker(
    output_key: String,
    config: OutputConfig,
    state: SharedState,
    renderer: RenderEngine,
) -> OutputWorkerHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let worker_output_key = output_key.clone();
    let worker_config = config.clone();

    let join_handle = tokio::spawn(async move {
        run_output_worker(worker_output_key, worker_config, state, renderer, shutdown_rx).await;
    });

    OutputWorkerHandle {
        config,
        shutdown_tx,
        join_handle,
    }
}

async fn stop_worker(worker: OutputWorkerHandle) {
    let _ = worker.shutdown_tx.send(true);
    let _ = worker.join_handle.await;
}

async fn run_output_worker(
    output_key: String,
    config: OutputConfig,
    state: SharedState,
    renderer: RenderEngine,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut sender = create_sender_backend(&output_key, &config);
    let mut native_retry_delay = Duration::from_secs(NATIVE_RETRY_BASE_SECS);
    let mut next_native_retry_at = Instant::now() + native_retry_delay;

    let frame_budget_ms = 1000.0 / config.normalized_framerate() as f64;
    let mut ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / config.normalized_framerate() as f64));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_ok() && *shutdown_rx.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                let frame_started = Instant::now();

                if matches!(sender, SenderBackend::Mock(_)) && Instant::now() >= next_native_retry_at {
                    match NativeNdiSender::new(&config) {
                        Ok(native_sender) => {
                            println!("[NDI Native] {} recovered native sender backend", output_key);
                            sender = SenderBackend::Native(native_sender);
                            native_retry_delay = Duration::from_secs(NATIVE_RETRY_BASE_SECS);
                        }
                        Err(error) => {
                            let next_delay = Duration::from_secs(
                                (native_retry_delay.as_secs() * 2).min(NATIVE_RETRY_MAX_SECS)
                            );
                            eprintln!(
                                "[NDI Native] {} native sender retry failed: {} (next retry in {}s)",
                                output_key,
                                error,
                                next_delay.as_secs()
                            );
                            native_retry_delay = next_delay;
                            next_native_retry_at = Instant::now() + native_retry_delay;
                        }
                    }
                }

                let (content_snapshot, style_snapshot, media_snapshot, transition_snapshot) = {
                    let guard = state.read().await;
                    (
                        guard
                            .contents
                            .get(&output_key)
                            .cloned()
                            .or_else(|| guard.contents.get("global").cloned()),
                        guard
                            .scene_styles
                            .get(&output_key)
                            .cloned()
                            .or_else(|| guard.scene_styles.get("global").cloned()),
                        guard
                            .media
                            .get(&output_key)
                            .cloned()
                            .or_else(|| guard.media.get("global").cloned()),
                        guard
                            .transitions
                            .get(&output_key)
                            .cloned()
                            .or_else(|| guard.transitions.get("global").cloned()),
                    )
                };

                let scene = RenderSceneInput {
                    output_key: output_key.clone(),
                    config: config.clone(),
                    content: content_snapshot,
                    scene_style: style_snapshot,
                    media: media_snapshot,
                    transition: transition_snapshot,
                };

                let frame = renderer.render_frame(&scene);
                let send_result = sender.send_frame(&frame);
                let mut send_succeeded = send_result.is_ok();
                if let Err(error) = send_result {
                    eprintln!(
                        "[NDI Native] {} {} sender error: {}",
                        output_key,
                        sender.backend_name(),
                        error
                    );
                    send_succeeded = false;

                    if matches!(sender, SenderBackend::Native(_)) {
                        sender = SenderBackend::Mock(MockNdiSender::new(&config.source_name));
                        native_retry_delay = Duration::from_secs(NATIVE_RETRY_BASE_SECS);
                        next_native_retry_at = Instant::now() + native_retry_delay;
                    }
                }

                let frame_elapsed_ms = frame_started.elapsed().as_secs_f64() * 1000.0;
                let dropped = frame_elapsed_ms > frame_budget_ms;
                let queue_depth = if dropped { 1 } else { 0 };
                let backend_name = sender.backend_name();

                let mut guard = state.write().await;
                guard.record_output_frame(
                    &output_key,
                    frame_elapsed_ms,
                    send_succeeded,
                    !send_succeeded,
                    dropped,
                    queue_depth,
                    backend_name,
                );
            }
        }
    }
}

fn create_sender_backend(output_key: &str, config: &OutputConfig) -> SenderBackend {
    match NativeNdiSender::new(config) {
        Ok(native_sender) => {
            println!("[NDI Native] {} using native NDI sender", output_key);
            SenderBackend::Native(native_sender)
        }
        Err(error) => {
            eprintln!(
                "[NDI Native] {} native sender unavailable: {}. Falling back to mock sender.",
                output_key, error
            );
            SenderBackend::Mock(MockNdiSender::new(&config.source_name))
        }
    }
}
