#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Agents Calling Windows 桌面壳。
//!
//! 这个进程只负责三件事：
//! 1. 启动或接管本机 Node 控制面；
//! 2. 把 WebView 导航到随机回环端口；
//! 3. 管理单实例、托盘和退出清理。
//!
//! 桥接协议、项目数据、模型调用和 MCP 配置全部留在 Node 层，避免桌面壳
//! 变成第二套业务实现。

use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent,
};
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `CreateProcess` 标志：启动 Node 时不弹出控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 控制面运行描述，来自 `%LOCALAPPDATA%\AI Bridge\ui-runtime.json`。
#[derive(Clone)]
struct RuntimeInfo {
    pid: u32,
    url: String,
    token: String,
}

/// 桌面壳共享状态。
///
/// `backend` 保存当前接管的控制面，托盘退出时用它做认证关闭；`quitting`
/// 用来区分“关窗口到托盘”和“真正退出”。
#[derive(Default)]
struct ShellState {
    backend: Mutex<Option<RuntimeInfo>>,
    quitting: AtomicBool,
}

fn main() {
    tauri::Builder::default()
        // 单实例插件必须最先注册：第二次启动只唤醒已有窗口，不再启动第二个 Node。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .manage(ShellState::default())
        .setup(|app| {
            create_tray(app.handle())?;

            // 后台启动 Node，不阻塞 WebView 显示启动页。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = start_backend(&handle) {
                    show_error(&handle, &error);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 用户点关闭按钮时隐藏到托盘；只有托盘“退出”才结束 Node。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<ShellState>();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Agents Calling")
        .run(|app, event| {
            // 系统关机或其它外部退出请求也要先关闭 Node；托盘退出已经自行处理。
            if let RunEvent::ExitRequested { code, api, .. } = event {
                let state = app.state::<ShellState>();
                if code.is_none() && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit_application(app);
                }
            }
        });
}

/// 创建托盘菜单。
///
/// 左键点击恢复主窗口，右键菜单提供“打开”和“退出”。TrayIcon 会被 Tauri
/// 资源表持有，即使局部队柄离开作用域，图标也不会消失。
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开 Agents Calling", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Agents Calling")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => quit_application(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 显示并聚焦主窗口；重复启动和托盘点击都走这个入口。
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 在启动页显示可读错误，避免窗口永远停在“正在启动”。
fn show_error(app: &AppHandle, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let status = serde_json::to_string("启动失败").unwrap_or_else(|_| "\"启动失败\"".into());
    let detail = serde_json::to_string(message).unwrap_or_else(|_| "\"未知错误\"".into());
    let script = format!(
        "(() => {{ const show = () => {{ const main = document.querySelector('main'); const status = document.getElementById('status'); const detail = document.getElementById('detail'); if (main) main.classList.add('failed'); if (status) status.textContent = {status}; if (detail) detail.textContent = {detail}; }}; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, {{once:true}}); else show(); }})();"
    );
    let _ = window.eval(script);
    let _ = window.show();
    let _ = window.set_focus();
}

/// 启动或接管 Node 控制面。
fn start_backend(app: &AppHandle) -> Result<(), String> {
    let data_dir = data_dir()?;
    let runtime_file = data_dir.join("ui-runtime.json");

    // 上次 App 崩溃但 Node 仍在运行时，直接接管；如果文件无效则继续尝试新启动。
    if let Some(runtime) = read_runtime(&runtime_file)? {
        if probe_runtime(&runtime) {
            remember_runtime(app, runtime.clone())?;
            return navigate_to_backend(app, &runtime);
        }
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位安装资源目录：{error}"))?;
    let node = resource_file(&resource_dir, "node.exe");
    let script = resource_file(&resource_dir, "src/app/control.mjs");
    if !node.is_file() {
        return Err(format!(
            "安装包缺少内置 Node 运行时：{}\n请重新安装 Agents Calling。",
            node.display()
        ));
    }
    if !script.is_file() {
        return Err(format!(
            "安装包缺少控制面脚本：{}\n请重新安装 Agents Calling。",
            script.display()
        ));
    }

    let log_path = data_dir.join("server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("无法打开后台日志：{error}"))?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("无法复制日志句柄：{error}"))?;

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .arg(&data_dir)
        .arg(std::process::id().to_string())
        .current_dir(&resource_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动内置 Node：{error}\n日志：{}",
            log_path.display()
        )
    })?;
    let child_pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(30);

    // Node 写运行描述不是原子的，轮询时允许短暂的 JSON 解析失败。
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|error| {
            format!(
                "无法读取后台进程状态：{error}\n日志：{}",
                log_path.display()
            )
        })? {
            return Err(format!(
                "后台服务启动失败（退出码 {}）。\n日志：{}",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "未知".into()),
                log_path.display()
            ));
        }
        if let Some(runtime) = read_runtime(&runtime_file)? {
            if runtime.pid == child_pid && probe_runtime(&runtime) {
                remember_runtime(app, runtime.clone())?;
                return navigate_to_backend(app, &runtime);
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    terminate_pid(child_pid);
    Err(format!(
        "后台服务在 30 秒内没有就绪。\n日志：{}",
        log_path.display()
    ))
}

/// 返回应用数据目录：`%LOCALAPPDATA%\AI Bridge`。
fn data_dir() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE").map(|home| {
                PathBuf::from(home)
                    .join("AppData")
                    .join("Local")
            })
        })
        .ok_or_else(|| "无法确定 %LOCALAPPDATA%，请检查 Windows 用户环境变量。".to_string())?;
    let dir = base.join("AI Bridge");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建数据目录：{error}"))?;
    Ok(dir)
}

/// 解析安装资源；开发模式下回退到仓库中的相对路径。
fn resource_file(resource_dir: &Path, relative: &str) -> PathBuf {
    let direct = resource_dir.join(relative);
    if direct.exists() {
        return direct;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

/// 读取并校验 `ui-runtime.json`。
fn read_runtime(path: &Path) -> Result<Option<RuntimeInfo>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取运行描述：{error}")),
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
    let url = value.get("url").and_then(Value::as_str);
    let token = value.get("token").and_then(Value::as_str);
    match (pid, url, token) {
        (Some(pid), Some(url), Some(token)) if safe_token(token) => Ok(Some(RuntimeInfo {
            pid,
            url: url.to_string(),
            token: token.to_string(),
        })),
        _ => Ok(None),
    }
}

/// token 来自本机私有文件，但仍拒绝空值和控制字符，防止 HTTP 头注入。
fn safe_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

/// 校验运行描述中的 URL 只能是本机回环地址。
fn runtime_address(runtime: &RuntimeInfo) -> Result<(String, u16), String> {
    let url = Url::parse(&runtime.url).map_err(|error| format!("运行描述 URL 无效：{error}"))?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.path() != "/" {
        return Err("运行描述 URL 不是本机回环控制面".into());
    }
    let port = url
        .port()
        .ok_or_else(|| "运行描述 URL 缺少端口".to_string())?;
    Ok((format!("127.0.0.1:{port}"), port))
}

/// 对控制面发起一次最小 HTTP 请求，只接受 200。
fn http_request(
    runtime: &RuntimeInfo,
    method: &str,
    path: &str,
    body: &str,
    timeout: Duration,
) -> Result<(), String> {
    if !safe_token(&runtime.token) {
        return Err("运行描述 token 无效".into());
    }
    if !path.starts_with('/') || path.contains('\r') || path.contains('\n') {
        return Err("控制面路径无效".into());
    }
    let (host, port) = runtime_address(runtime)?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("连接控制面失败：{error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("设置读取超时失败：{error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("设置写入超时失败：{error}"))?;
    let origin = runtime.url.trim_end_matches('/');
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nx-bridge-ui: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        runtime.token,
        body.as_bytes().len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送控制面请求失败：{error}"))?;
    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|error| format!("读取控制面响应失败：{error}"))?;
    let first = raw.lines().next().unwrap_or_default();
    if first.split_whitespace().nth(1) != Some("200") {
        return Err(format!("控制面返回非 200：{first}"));
    }
    Ok(())
}

/// 用认证接口确认控制面仍在运行。
fn probe_runtime(runtime: &RuntimeInfo) -> bool {
    http_request(
        runtime,
        "GET",
        "/api/version",
        "",
        Duration::from_millis(1500),
    )
    .is_ok()
}

/// 保存当前控制的运行描述，供托盘退出时使用。
fn remember_runtime(app: &AppHandle, runtime: RuntimeInfo) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let mut backend = state
        .backend
        .lock()
        .map_err(|_| "桌面状态锁已损坏".to_string())?;
    *backend = Some(runtime);
    Ok(())
}

/// 把主窗口导航到控制面地址。
fn navigate_to_backend(app: &AppHandle, runtime: &RuntimeInfo) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口尚未创建".to_string())?;
    let url = Url::parse(&runtime.url).map_err(|error| format!("控制面 URL 无效：{error}"))?;
    window
        .navigate(url)
        .map_err(|error| format!("无法加载本机界面：{error}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// 走托盘“退出”时先关闭 Node，再结束桌面壳。
fn quit_application(app: &AppHandle) {
    let state = app.state::<ShellState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let runtime = state
        .backend
        .lock()
        .ok()
        .and_then(|backend| backend.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(runtime) = runtime {
            shutdown_runtime(&runtime);
        }
        app.exit(0);
    });
}

/// 先调用认证关闭接口，等待最多约 5 秒；超时后终止整棵进程树。
fn shutdown_runtime(runtime: &RuntimeInfo) {
    let sent = http_request(
        runtime,
        "POST",
        "/api/shutdown",
        "{}",
        Duration::from_millis(1500),
    )
    .is_ok();
    if !sent {
        terminate_pid(runtime.pid);
        return;
    }
    for _ in 0..25 {
        std::thread::sleep(Duration::from_millis(200));
        let alive = http_request(
            runtime,
            "GET",
            "/api/version",
            "",
            Duration::from_millis(600),
        )
        .is_ok();
        if !alive {
            return;
        }
    }
    terminate_pid(runtime.pid);
}

/// 终止指定进程树。
///
/// Windows 使用固定参数的 `taskkill /T /F`，不会把用户输入交给 shell；非 Windows
/// 仅用于本地编译检查。
fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        let system_root = env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let mut command = Command::new(system_root.join("System32").join("taskkill.exe"));
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.creation_flags(CREATE_NO_WINDOW);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

