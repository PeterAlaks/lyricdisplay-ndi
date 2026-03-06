use serde_json::json;

use crate::state::RuntimeState;

pub fn stats_snapshot(state: &RuntimeState) -> serde_json::Value {
    let mut total_render_fps: f64 = 0.0;
    let mut total_send_fps: f64 = 0.0;
    let mut total_dropped_frames = 0_u64;
    let mut total_send_failures = 0_u64;
    let mut frame_time_avg_sum: f64 = 0.0;
    let mut frame_time_p95_max: f64 = 0.0;
    let mut active_output_count = 0_u32;
    let mut queue_depth_max = 0_u32;
    let mut native_output_count = 0_u32;
    let mut mock_output_count = 0_u32;

    for stats in state.output_stats.values() {
        if !stats.enabled {
            continue;
        }

        active_output_count += 1;
        if stats.backend == "native" {
            native_output_count += 1;
        } else {
            mock_output_count += 1;
        }

        total_render_fps += stats.render_fps;
        total_send_fps += stats.send_fps;
        total_dropped_frames += stats.dropped_frames;
        total_send_failures += stats.send_failures;
        frame_time_avg_sum += stats.avg_frame_ms;
        frame_time_p95_max = frame_time_p95_max.max(stats.p95_frame_ms);
        queue_depth_max = queue_depth_max.max(stats.queue_depth);
    }

    let avg_frame_ms = if active_output_count == 0 {
        0.0
    } else {
        frame_time_avg_sum / active_output_count as f64
    };

    json!({
        "capture_fps": 0.0,
        "render_fps": total_render_fps,
        "send_fps": total_send_fps,
        "dropped_frames": total_dropped_frames,
        "avg_frame_ms": avg_frame_ms,
        "p95_frame_ms": frame_time_p95_max,
        "queue_depth": queue_depth_max,
        "ndi_send_failures": total_send_failures,
        "active_output_count": active_output_count,
        "native_output_count": native_output_count,
        "mock_output_count": mock_output_count,
        "outputs": &state.output_stats,
    })
}

pub fn health_snapshot(state: &RuntimeState) -> serde_json::Value {
    let active_outputs = state.outputs.values().filter(|output| output.enabled).count();
    let mut warning_flags = Vec::<String>::new();
    if active_outputs == 0 {
        warning_flags.push("no_outputs_enabled".to_string());
    }
    if state
        .output_stats
        .values()
        .any(|stats| stats.enabled && stats.backend == "mock")
    {
        warning_flags.push("ndi_runtime_unavailable".to_string());
    }

    json!({
        "uptime_ms": state.started_at.elapsed().as_millis(),
        "memory_mb": 0,
        "gpu_backend": "scaffold",
        "decode_status": "idle",
        "ndi_backend": if state
            .output_stats
            .values()
            .any(|stats| stats.enabled && stats.backend == "native")
        {
            "native"
        } else {
            "mock"
        },
        "active_outputs": active_outputs,
        "warning_flags": warning_flags,
    })
}
