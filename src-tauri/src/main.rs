// main.rs — MyTemple Knowledge 应用入口（Tauri 模式）
// 启动 Tauri 窗口外壳 + 同进程 axum HTTP 服务。
// 混合架构：前端经 axum 取静态资源与 /api（已移植原生处理，未移植代理 sidecar）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mytemple_server::run();
}
