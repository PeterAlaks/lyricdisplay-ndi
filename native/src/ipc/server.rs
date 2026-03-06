use anyhow::{Context, Result};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::ipc::message::{CommandEnvelope, EventEnvelope};
use crate::ndi::NdiOutputManager;
use crate::state::SharedState;
use crate::telemetry::{health_snapshot, stats_snapshot};

pub async fn run_ipc_server(
    bind_addr: &str,
    state: SharedState,
    shutdown_tx: watch::Sender<bool>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<()> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("failed to bind IPC listener on {bind_addr}"))?;
    let output_manager = NdiOutputManager::new(state.clone());

    println!("[Native Companion] IPC listener ready at {bind_addr}");

    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_ok() && *shutdown_rx.borrow() {
                    println!("[Native Companion] Shutdown signal received; stopping IPC listener");
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, remote)) => {
                        let state_clone = state.clone();
                        let shutdown_tx_clone = shutdown_tx.clone();
                        let output_manager_clone = output_manager.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_client(
                                socket,
                                state_clone,
                                shutdown_tx_clone,
                                output_manager_clone,
                            )
                            .await
                            {
                                eprintln!("[Native Companion] Client {remote} error: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        eprintln!("[Native Companion] IPC accept error: {error}");
                    }
                }
            }
        }
    }

    output_manager.shutdown_all().await;
    Ok(())
}

async fn handle_client(
    socket: TcpStream,
    state: SharedState,
    shutdown_tx: watch::Sender<bool>,
    output_manager: NdiOutputManager,
) -> Result<()> {
    let (reader, mut writer) = socket.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Some(line) = lines.next_line().await.context("failed reading IPC line")? {
        if line.trim().is_empty() {
            continue;
        }

        let parsed = serde_json::from_str::<CommandEnvelope>(&line);

        match parsed {
            Ok(command) => {
                let events = handle_command(
                    command,
                    state.clone(),
                    shutdown_tx.clone(),
                    output_manager.clone(),
                )
                .await;
                for event in events {
                    write_event(&mut writer, event).await?;
                }
            }
            Err(error) => {
                let event = EventEnvelope::new(
                    "error",
                    None,
                    None,
                    now_ms(),
                    json!({
                        "code": "invalid_json",
                        "message": error.to_string(),
                        "recoverable": true
                    }),
                );
                write_event(&mut writer, event).await?;
            }
        }
    }

    Ok(())
}

async fn handle_command(
    command: CommandEnvelope,
    state: SharedState,
    shutdown_tx: watch::Sender<bool>,
    output_manager: NdiOutputManager,
) -> Vec<EventEnvelope> {
    let seq = command.seq;
    let output = command.output.clone();
    let timestamp = now_ms();
    let _client_ts = command.ts;

    match command.kind.as_str() {
        "hello" => {
            let payload = json!({
                "name": "lyricdisplay-ndi-native",
                "version": env!("CARGO_PKG_VERSION"),
                "capabilities": {
                    "commands": [
                        "hello",
                        "set_outputs",
                        "set_scene_style",
                        "set_content",
                        "set_media",
                        "set_transition",
                        "request_stats",
                        "shutdown"
                    ],
                    "transport": "tcp-json-lines"
                }
            });

            vec![EventEnvelope::new("ack", output, seq, timestamp, payload)]
        }
        "set_outputs" => {
            let (changed, desired_outputs) = {
                let mut guard = state.write().await;
                guard.mark_seq(seq);
                let changed = guard.apply_outputs_from_payload(&command.payload);
                let desired_outputs = guard.enabled_output_configs();
                (changed, desired_outputs)
            };
            let active_workers = output_manager.reconcile_outputs(desired_outputs).await;

            vec![EventEnvelope::new(
                "ack",
                output,
                seq,
                timestamp,
                json!({
                    "changed_outputs": changed,
                    "active_workers": active_workers,
                }),
            )]
        }
        "set_scene_style" => {
            let mut guard = state.write().await;
            guard.mark_seq(seq);
            let key = output.clone().unwrap_or_else(|| "global".to_string());
            guard.scene_styles.insert(key, command.payload);

            vec![EventEnvelope::new("ack", output, seq, timestamp, json!({ "status": "applied" }))]
        }
        "set_content" => {
            let mut guard = state.write().await;
            guard.mark_seq(seq);
            let key = output.clone().unwrap_or_else(|| "global".to_string());
            guard.contents.insert(key, command.payload);

            vec![EventEnvelope::new("ack", output, seq, timestamp, json!({ "status": "applied" }))]
        }
        "set_media" => {
            let mut guard = state.write().await;
            guard.mark_seq(seq);
            let key = output.clone().unwrap_or_else(|| "global".to_string());
            guard.media.insert(key, command.payload);

            vec![EventEnvelope::new("ack", output, seq, timestamp, json!({ "status": "applied" }))]
        }
        "set_transition" => {
            let mut guard = state.write().await;
            guard.mark_seq(seq);
            let key = output.clone().unwrap_or_else(|| "global".to_string());
            guard.transitions.insert(key, command.payload);

            vec![EventEnvelope::new("ack", output, seq, timestamp, json!({ "status": "applied" }))]
        }
        "request_stats" => {
            let guard = state.read().await;
            vec![
                EventEnvelope::new("stats", output.clone(), seq, timestamp, stats_snapshot(&guard)),
                EventEnvelope::new("health", output, seq, timestamp, health_snapshot(&guard)),
            ]
        }
        "shutdown" => {
            output_manager.shutdown_all().await;
            let _ = shutdown_tx.send(true);
            vec![EventEnvelope::new(
                "ack",
                output,
                seq,
                timestamp,
                json!({ "status": "shutting_down" }),
            )]
        }
        other => vec![EventEnvelope::new(
            "error",
            output,
            seq,
            timestamp,
            json!({
                "code": "unknown_command",
                "message": format!("unsupported command type: {other}"),
                "recoverable": true
            }),
        )],
    }
}

async fn write_event(writer: &mut tokio::net::tcp::OwnedWriteHalf, event: EventEnvelope) -> Result<()> {
    let data = serde_json::to_string(&event).context("failed to serialize event")?;
    writer
        .write_all(data.as_bytes())
        .await
        .context("failed writing event payload")?;
    writer
        .write_all(b"\n")
        .await
        .context("failed writing event newline")?;
    Ok(())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}
