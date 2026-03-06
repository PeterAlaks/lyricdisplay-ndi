mod ipc;
mod media;
mod ndi;
mod render;
mod scene;
mod state;
mod telemetry;

use std::sync::Arc;

use clap::Parser;
use state::{RuntimeState, SharedState};
use tokio::sync::watch;

#[derive(Debug, Parser)]
#[command(name = "lyricdisplay-ndi-native")]
#[command(about = "Native NDI companion scaffold for LyricDisplay", long_about = None)]
struct Cli {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 9137)]
    port: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let bind_addr = format!("{}:{}", cli.host, cli.port);

    println!("===========================================");
    println!("  LyricDisplay NDI Native Companion v{}", env!("CARGO_PKG_VERSION"));
    println!("===========================================");
    println!("  IPC: tcp://{bind_addr}");
    println!("");

    // Phase-1 scaffold: keep architecture modules initialized and ready
    // for renderer/NDI/media expansion in subsequent milestones.
    let _render_engine = render::RenderEngine::new();
    let _scene_graph = scene::SceneGraph::new();
    let _media_pipeline = media::MediaPipeline::new();

    let state: SharedState = Arc::new(tokio::sync::RwLock::new(RuntimeState::new()));

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let server_future = ipc::server::run_ipc_server(&bind_addr, state, shutdown_tx.clone(), shutdown_rx);
    tokio::pin!(server_future);

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("[Native Companion] Ctrl+C received; shutting down");
            let _ = shutdown_tx.send(true);
            server_future.as_mut().await?;
        }
        result = server_future.as_mut() => {
            result?;
        }
    }

    println!("[Native Companion] Shutdown complete");
    Ok(())
}
