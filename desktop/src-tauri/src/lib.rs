use std::{
    io::{Error as IoError, ErrorKind},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
struct ServerState(Mutex<ServerStatus>);

struct ServerRuntime {
    url: String,
    child: CommandChild,
}

#[derive(Default)]
struct ServerStatus {
    runtime: Option<ServerRuntime>,
    startup_error: Option<String>,
}

#[tauri::command]
fn get_server_url(state: State<'_, ServerState>) -> Result<String, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "desktop server state is unavailable".to_string())?;

    if let Some(runtime) = guard.runtime.as_ref() {
        return Ok(runtime.url.clone());
    }

    Err(guard
        .startup_error
        .clone()
        .unwrap_or_else(|| "desktop server did not start".to_string()))
}

fn reserve_local_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|err| format!("bind local port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("read local port: {err}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_server(url_host: &str, port: u16) -> Result<(), String> {
    let addr: SocketAddr = format!("{url_host}:{port}")
        .parse()
        .map_err(|err| format!("parse server address: {err}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);

    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    Err(format!(
        "desktop server did not start listening on {url_host}:{port} within 10 seconds"
    ))
}

fn resolve_app_root(_app: &AppHandle) -> Result<PathBuf, String> {
    // 历史用途：此前 sidecar launcher 用 dynamic file:// import 加载磁盘上
    // 的 src/server/index.ts 和 preload.ts，所以 Tauri 必须把整个 src/ +
    // node_modules/ 当 Resource 一起 ship 到 .app/Contents/Resources/app/。
    //
    // 现在 launcher 改成静态 import + bun build --compile 整棵静态打进二进制，
    // server / cli sidecar 不再读磁盘上的 src/ 或 node_modules/。CLAUDE_APP_ROOT
    // 现在只剩一个名义上的"app 安装根目录"作用，给 conversationService
    // 在 spawn CLI 子进程时通过 --app-root 透传。
    //
    // 我们直接用当前可执行文件所在目录作为 app_root：
    //   Dev:  desktop/src-tauri/target/<profile>/  （rust 跑出来的 binary 那一层）
    //   Prod: <App>.app/Contents/MacOS/             （sidecar 二进制的同级目录）
    //
    // 这样 P0 不再依赖 BaseDirectory::Resource 解出的 app/ 目录，可以从
    // tauri.conf.json 的 resources 里把 src/、node_modules/、preload.ts、stubs/
    // 全部干掉，直接砍掉 ~300MB 包体。
    let exe = std::env::current_exe()
        .map_err(|err| format!("resolve current exe path: {err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current exe has no parent dir".to_string())?
        .to_path_buf();
    Ok(dir)
}

fn start_server_sidecar(app: &AppHandle) -> Result<ServerRuntime, String> {
    let host = "127.0.0.1";
    let port = reserve_local_port()?;
    let url = format!("http://{host}:{port}");
    let app_root = resolve_app_root(app)?;
    let app_root_arg = app_root.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("claude-server")
        .map_err(|err| format!("resolve server sidecar: {err}"))?
        .args([
            "--app-root",
            &app_root_arg,
            "--host",
            host,
            "--port",
            &port.to_string(),
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|err| format!("spawn server sidecar: {err}"))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    println!("[claude-server] {}", line.trim_end());
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    eprintln!("[claude-server] {}", line.trim_end());
                }
                _ => {}
            }
        }
    });

    wait_for_server(host, port)?;

    Ok(ServerRuntime { url, child })
}

fn stop_server_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerState>() else {
        return;
    };

    let Ok(mut guard) = state.0.lock() else {
        return;
    };

    if let Some(runtime) = guard.runtime.take() {
        let _ = runtime.child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ServerState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![get_server_url])
        .setup(|app| {
            let state = app.state::<ServerState>();
            let mut guard = state
                .0
                .lock()
                .map_err(|_| IoError::new(ErrorKind::Other, "server state lock poisoned"))?;

            match start_server_sidecar(&app.handle()) {
                Ok(runtime) => {
                    guard.runtime = Some(runtime);
                    guard.startup_error = None;
                }
                Err(err) => {
                    eprintln!("[desktop] failed to start local server: {err}");
                    guard.runtime = None;
                    guard.startup_error = Some(err);
                }
            }

            let _window = app.get_webview_window("main").unwrap();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_server_sidecar(app_handle);
        }
    });
}
