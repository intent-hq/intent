mod rpc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(rpc::init(app.handle()));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![rpc::rpc_call])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
