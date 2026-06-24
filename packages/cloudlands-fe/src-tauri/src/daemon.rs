//! Bundled `intentd` lifecycle.
//!
//! On startup the Tauri core spawns the bundled `intentd` sidecar
//! (`serve --listen uds`) unless a daemon is already listening on the
//! configured socket, waits for the UDS to accept connections, and then lets
//! the [`crate::rpc`] client connect. On exit it stops the daemon we spawned
//! gracefully (SIGTERM, then SIGKILL as a backstop) so no orphan survives.
//!
//! Socket/data dirs are configurable via the same env vars the daemon and the
//! [`crate::rpc`] client honor (`INTENTD_SOCKET` / `INTENTD_DATA_DIR`); the
//! default is the platform app-data path resolved by [`crate::rpc`].

#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::sync::Mutex;
#[cfg(unix)]
use std::time::{Duration, Instant};

use tauri::AppHandle;
#[cfg(unix)]
use tauri::Manager;

#[cfg(unix)]
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Lifecycle handle for the spawned daemon, stored as Tauri managed state.
/// Holds the child only when *we* spawned it, so [`shutdown`] never signals a
/// pre-existing daemon owned by the user.
#[derive(Default)]
pub struct DaemonHandle {
    #[cfg(unix)]
    child: Mutex<Option<CommandChild>>,
}

/// Spawn the bundled daemon if one is not already running, then wait for the
/// socket to be ready. Errors are logged, not fatal: the reconnecting client
/// will keep retrying if the daemon comes up later.
pub fn start(app: &AppHandle) {
    #[cfg(unix)]
    {
        let socket = crate::rpc::resolve_socket_path();
        if socket_is_live(&socket) {
            log::info!(
                "intentd already running at {}; not spawning",
                socket.display()
            );
            return;
        }
        match spawn(app, &socket) {
            Ok(child) => {
                if let Some(handle) = app.try_state::<DaemonHandle>() {
                    *handle.child.lock().unwrap() = Some(child);
                }
            }
            Err(e) => log::error!("failed to spawn intentd sidecar: {e}"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = app;
    }
}

/// Stop the daemon we spawned (no-op if we did not spawn one). Sends SIGTERM
/// for a graceful teardown (intentd removes its socket + pidfile), then escalates
/// to SIGKILL if it has not exited, guaranteeing no orphaned process.
pub fn shutdown(app: &AppHandle) {
    #[cfg(unix)]
    {
        let Some(handle) = app.try_state::<DaemonHandle>() else {
            return;
        };
        let child = handle.child.lock().unwrap().take();
        let Some(child) = child else {
            return;
        };
        let pid = child.pid() as libc::pid_t;
        log::info!("stopping intentd (pid {pid})");
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = app;
    }
}

#[cfg(unix)]
fn spawn(app: &AppHandle, socket: &Path) -> Result<CommandChild, String> {
    let command = app
        .shell()
        .sidecar("intentd")
        .map_err(|e| e.to_string())?
        .args(["serve", "--listen", "uds"]);
    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    log::info!("spawned bundled intentd (serve --listen uds)");

    // Forward the daemon's stdout/stderr into our log so its tracing output is
    // visible, and note when it exits unexpectedly.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    log::info!("intentd: {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("intentd exited: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    wait_for_socket(socket, Duration::from_secs(15));
    Ok(child)
}

/// Whether a daemon is currently accepting connections on `path`.
#[cfg(unix)]
fn socket_is_live(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

/// Block until the socket accepts a connection or `timeout` elapses.
#[cfg(unix)]
fn wait_for_socket(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if socket_is_live(path) {
            log::info!("intentd socket ready at {}", path.display());
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::warn!(
        "intentd socket not ready after {timeout:?} at {}",
        path.display()
    );
    false
}
