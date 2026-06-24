mod daemon;
mod rpc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Spawn the bundled intentd (if not already running) and wait for the
      // socket before the rpc client connects.
      app.manage(daemon::DaemonHandle::default());
      daemon::start(app.handle());
      app.manage(rpc::init(app.handle()));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![rpc::rpc_call])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Stop the daemon we spawned so quitting leaves no orphan process.
      if let tauri::RunEvent::Exit = event {
        daemon::shutdown(app_handle);
      }
    });
}
