//! Windows game child webview. No remote page gets application IPC privileges.
//! The existing CDP capture/input pipeline attaches before game navigation.
use super::{
    chromium::cdp, flow::FlowBridges, CaptureBackend, CaptureCtx, CaptureDescriptor, CaptureKind,
    ShutdownToken,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::{
    net::TcpListener,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

pub const LABEL: &str = "embedded-game";
pub const BLANK: &str = "about:blank#akagi-teacher-game";
pub const WINDOW_NAME: &str = "akagi-teacher-game";
const GAME_URL: &str = "https://game.maj-soul.com/1/";
static PORT: OnceLock<u16> = OnceLock::new();

/// Call before Tauri creates any WebView2 environments. Both shell and child
/// use the same default profile/environment, keeping the debug endpoint local.
pub fn prepare() -> Result<()> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    PORT.set(port)
        .map_err(|_| anyhow::anyhow!("embedded browser already prepared"))?;
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        format!("{existing} --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"),
    );
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}
impl Bounds {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width >= 1.0
            && self.height >= 1.0
            && self.width <= 16384.0
            && self.height <= 16384.0
    }
}
pub fn navigation_allowed(url: &tauri::Url) -> bool {
    url.as_str() == BLANK || url.scheme() == "https"
}

pub fn start_url(raw: &str) -> String {
    if let Ok(url) = tauri::Url::parse(raw) {
        let host = url.host_str().unwrap_or_default();
        if url.scheme() == "https"
            && [
                "maj-soul.com",
                "mahjongsoul.com",
                "majsoul.com",
                "mahjongsoul.game.yo-star.com",
            ]
            .iter()
            .any(|root| host == *root || host.ends_with(&format!(".{root}")))
        {
            return url.into();
        }
    }
    GAME_URL.into()
}

pub fn sync_child(app: &AppHandle, bounds: Bounds) -> Result<()> {
    anyhow::ensure!(
        cfg!(target_os = "windows"),
        "内嵌雀魂目前仅支持 Windows，请使用设置中的外部 Chromium 模式"
    );
    anyhow::ensure!(bounds.valid(), "invalid game webview bounds");
    let child = match app.get_webview(LABEL) {
        Some(child) => child,
        None if !bounds.visible => return Ok(()),
        None => {
            let window = app.get_window("main").context("main window missing")?;
            let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(BLANK.parse()?))
                .initialization_script(format!("window.name = {WINDOW_NAME:?};"))
                .on_navigation(navigation_allowed);
            // The blank marker lets CDP enable Network before navigating to
            // the game, so initial lobby/account WebSocket frames aren't lost.
            window.add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )?
        }
    };
    if bounds.visible {
        child.set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })?;
        child.show()?;
    } else {
        child.hide()?;
    }
    Ok(())
}

pub struct EmbeddedBackend {
    pub block_telemetry: bool,
    pub start_url: String,
}
#[async_trait]
impl CaptureBackend for EmbeddedBackend {
    fn descriptor(&self) -> CaptureDescriptor {
        CaptureDescriptor {
            kind: CaptureKind::Chromium,
            label: "内嵌雀魂 · WebView2".into(),
        }
    }
    async fn run(self: Box<Self>, ctx: CaptureCtx, shutdown: ShutdownToken) -> Result<()> {
        let port = *PORT.get().context("WebView2调试端点未初始化，请重启程序")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()?;
        let endpoint = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Ok(response) = client
                    .get(format!("http://127.0.0.1:{port}/json/version"))
                    .send()
                    .await
                {
                    if let Ok(value) = response.json::<serde_json::Value>().await {
                        if let Some(endpoint) = value["webSocketDebuggerUrl"].as_str() {
                            let url: tauri::Url = endpoint.parse()?;
                            anyhow::ensure!(
                                url.scheme() == "ws"
                                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                                    && url.port() == Some(port),
                                "unexpected browser endpoint"
                            );
                            return Ok::<_, anyhow::Error>(endpoint.to_owned());
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let endpoint = tokio::select! { _ = shutdown.wait() => return Ok(()), result = endpoint => result.context("内嵌浏览器启动超时")?? };
        let mut hooks = ctx
            .autoplay
            .as_ref()
            .map(|a| crate::bridge::BridgeHooks {
                time_budget: Some(a.time_budget.clone()),
                input_watch: Some(a.input_watch.clone()),
                tenhou_state: None,
                riichi_inject: None,
                notify: None,
            })
            .unwrap_or_default();
        hooks.notify = Some(ctx.notify_bus.clone());
        let bridges = Arc::new(FlowBridges::<cdp::FlowKey>::new(
            ctx.session.clone(),
            ctx.platform,
            hooks,
        ));
        let task = cdp::run(
            &endpoint,
            bridges,
            ctx.mjai_bus,
            ctx.session.inspector(),
            ctx.autoplay.clone(),
            ctx.http,
            ctx.notify_bus,
            self.block_telemetry,
            Some(&self.start_url),
        );
        let result = tokio::select! { _ = shutdown.wait() => Ok(()), result = task => result };
        if let Some(a) = ctx.autoplay {
            *a.page.write().await = None;
            *a.canvas_rect.write().await = None;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_and_remote_navigation_are_bounded() {
        let good = Bounds {
            x: 0.,
            y: 48.,
            width: 1100.,
            height: 800.,
            visible: true,
        };
        assert!(good.valid());
        for bad in [f64::NAN, f64::INFINITY, -1., 0., 20000.] {
            assert!(!Bounds { width: bad, ..good }.valid());
        }
        assert_eq!(
            start_url("https://game.mahjongsoul.com/"),
            "https://game.mahjongsoul.com/"
        );
        for raw in [
            "https://maj-soul.com.evil.test/",
            "http://game.maj-soul.com/1/",
            "https://tenhou.net/4/",
            "invalid",
        ] {
            assert_eq!(start_url(raw), GAME_URL);
        }
        assert!(navigation_allowed(&GAME_URL.parse().unwrap()));
        assert!(navigation_allowed(&BLANK.parse().unwrap()));
        for url in [
            "file:///C:/secret",
            "tauri://localhost",
            "http://evil.test",
            "javascript:alert(1)",
        ] {
            assert!(!navigation_allowed(&url.parse().unwrap()));
        }
    }
}
