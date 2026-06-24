//! UDS JSON-RPC 2.0 client + Tauri bridge to the webview.
//!
//! Owns a persistent Unix-domain-socket connection to `intentd`, sends
//! newline-delimited JSON-RPC requests, correlates responses by `id`, and
//! forwards server-pushed `events.event` notifications to the webview as the
//! `intentd://event` Tauri event. Reconnects with backoff and re-sends tracked
//! `events.subscribe` subscriptions per PROTOCOL.md §4 / §10.2.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// JSON-RPC error shape (`{ code, message, data? }`). Carries both server
/// errors (passed through) and transport failures (synthesized).
#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Implementation-defined transport error (connection lost, timeout, not
/// connected); within the JSON-RPC server-error range.
const TRANSPORT_ERROR: i64 = -32000;
const INTERNAL_ERROR: i64 = -32603;

impl RpcError {
    fn transport(message: impl Into<String>) -> Self {
        Self { code: TRANSPORT_ERROR, message: message.into(), data: None }
    }

    fn from_value(err: &Value) -> Self {
        Self {
            code: err.get("code").and_then(Value::as_i64).unwrap_or(INTERNAL_ERROR),
            message: err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string(),
            data: err.get("data").cloned(),
        }
    }
}

/// Resolve the daemon socket path: `INTENTD_SOCKET` (full path) overrides
/// everything; otherwise the data dir from `INTENTD_DATA_DIR` or the platform
/// default (`~/Library/Application Support/intentd` on macOS) + `intentd.sock`.
/// Mirrors the daemon's `directories`-based resolution.
pub fn resolve_socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("INTENTD_SOCKET") {
        return PathBuf::from(p);
    }
    let data_dir = match std::env::var_os("INTENTD_DATA_DIR") {
        Some(p) => PathBuf::from(p),
        None => directories::ProjectDirs::from("", "", "intentd")
            .map(|d| d.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("intentd")),
    };
    data_dir.join("intentd.sock")
}

/// Persistent JSON-RPC client over the daemon UDS. Shared via Tauri state.
pub struct RpcClient {
    socket_path: PathBuf,
    next_id: AtomicU64,
    #[cfg_attr(not(unix), allow(dead_code))]
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, RpcError>>>>,
    #[cfg_attr(not(unix), allow(dead_code))]
    subscriptions: Mutex<Vec<Value>>,
    #[cfg(unix)]
    writer: tokio::sync::Mutex<Option<tokio::net::unix::OwnedWriteHalf>>,
    #[cfg_attr(not(unix), allow(dead_code))]
    app: AppHandle,
}

impl RpcClient {
    fn new(app: AppHandle, socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(Vec::new()),
            #[cfg(unix)]
            writer: tokio::sync::Mutex::new(None),
            app,
        }
    }
}

/// Build the client, manage it, and (on unix) spawn the reconnecting
/// connection task. Returns the shared handle so the caller can `manage` it.
pub fn init(app: &AppHandle) -> Arc<RpcClient> {
    let client = Arc::new(RpcClient::new(app.clone(), resolve_socket_path()));
    #[cfg(unix)]
    {
        let task = client.clone();
        tauri::async_runtime::spawn(async move { run_connection(task).await });
    }
    client
}

/// Async Tauri command: forward one JSON-RPC call to the daemon. `params`
/// defaults to `{}`. Server and transport errors surface as `RpcError`.
#[tauri::command]
pub async fn rpc_call(
    state: tauri::State<'_, Arc<RpcClient>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let client = state.inner().clone();
    client.call(method, params.unwrap_or_else(|| json!({}))).await
}

#[cfg(not(unix))]
impl RpcClient {
    pub async fn call(&self, _method: String, _params: Value) -> Result<Value, RpcError> {
        Err(RpcError::transport(
            "UDS transport is not supported on this platform",
        ))
    }
}

#[cfg(unix)]
mod unix_transport {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::sync::oneshot;
    use tokio::time::{sleep, timeout};

    const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
    const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
    const MAX_BACKOFF: Duration = Duration::from_secs(5);

    impl RpcClient {
        /// Send one request and await its correlated response.
        pub async fn call(&self, method: String, params: Value) -> Result<Value, RpcError> {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let track_sub = method == "events.subscribe";
            let frame = serde_json::to_string(&json!({
                "jsonrpc": "2.0", "id": id, "method": method, "params": params,
            }))
            .map_err(|e| RpcError::transport(format!("serialize request: {e}")))?;

            let (tx, rx) = oneshot::channel();
            self.pending.lock().unwrap().insert(id, tx);

            {
                let mut guard = self.writer.lock().await;
                match guard.as_mut() {
                    Some(w) => {
                        if let Err(e) = write_frame(w, &frame).await {
                            self.pending.lock().unwrap().remove(&id);
                            return Err(RpcError::transport(format!("write failed: {e}")));
                        }
                    }
                    None => {
                        self.pending.lock().unwrap().remove(&id);
                        return Err(RpcError::transport("not connected to intentd"));
                    }
                }
            }

            match timeout(REQUEST_TIMEOUT, rx).await {
                Ok(Ok(Ok(result))) => {
                    if track_sub {
                        self.subscriptions.lock().unwrap().push(params);
                    }
                    Ok(result)
                }
                Ok(Ok(Err(err))) => Err(err),
                Ok(Err(_canceled)) => Err(RpcError::transport("connection closed before response")),
                Err(_elapsed) => {
                    self.pending.lock().unwrap().remove(&id);
                    Err(RpcError::transport("request timed out"))
                }
            }
        }

        fn handle_frame(&self, line: &str) {
            if line.is_empty() {
                return;
            }
            let value: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => return,
            };
            if let Some(id) = value.get("id").and_then(Value::as_u64) {
                if value.get("result").is_some() || value.get("error").is_some() {
                    if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                        let outcome = match value.get("error") {
                            Some(err) => Err(RpcError::from_value(err)),
                            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(outcome);
                    }
                    return;
                }
            }
            if value.get("method").and_then(Value::as_str) == Some("events.event") {
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                let _ = self.app.emit("intentd://event", params);
            }
        }

        async fn replay_subscriptions(&self) {
            let subs = self.subscriptions.lock().unwrap().clone();
            for params in subs {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let frame = match serde_json::to_string(&json!({
                    "jsonrpc": "2.0", "id": id, "method": "events.subscribe", "params": params,
                })) {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let mut guard = self.writer.lock().await;
                if let Some(w) = guard.as_mut() {
                    let _ = write_frame(w, &frame).await;
                }
            }
        }

        fn fail_all_pending(&self) {
            let mut map = self.pending.lock().unwrap();
            for (_id, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::transport("connection closed")));
            }
        }
    }

    async fn write_frame(
        w: &mut tokio::net::unix::OwnedWriteHalf,
        frame: &str,
    ) -> std::io::Result<()> {
        w.write_all(frame.as_bytes()).await?;
        w.write_all(b"\n").await?;
        w.flush().await
    }

    /// Reconnecting connection loop: connect → replay subs → read frames until
    /// EOF/error → fail pending → back off and retry.
    pub(super) async fn run_connection(client: Arc<RpcClient>) {
        let mut backoff = INITIAL_BACKOFF;
        loop {
            if let Ok(stream) = UnixStream::connect(&client.socket_path).await {
                backoff = INITIAL_BACKOFF;
                let (read_half, write_half) = stream.into_split();
                *client.writer.lock().await = Some(write_half);
                client.replay_subscriptions().await;
                let _ = client.app.emit("intentd://status", json!({ "connected": true }));

                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => client.handle_frame(line.trim()),
                    }
                }

                *client.writer.lock().await = None;
                client.fail_all_pending();
                let _ = client.app.emit("intentd://status", json!({ "connected": false }));
            }
            sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

#[cfg(unix)]
use unix_transport::run_connection;
