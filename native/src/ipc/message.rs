use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct CommandEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default)]
    pub ts: Option<i64>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct EventEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub ts: i64,
    pub payload: Value,
}

impl EventEnvelope {
    pub fn new(kind: &str, output: Option<String>, seq: Option<u64>, ts: i64, payload: Value) -> Self {
        Self {
            kind: kind.to_string(),
            output,
            seq,
            ts,
            payload,
        }
    }
}
