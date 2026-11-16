//! Non-modal accessory window and narrow settings patch; never restarts capture.
use crate::config::{AppConfig, DelayModelConfig, MajsoulAutoplayConfig, SessionConfig};
use crate::ipc::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "settings";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimingSettings {
    pub majsoul: MajsoulAutoplayConfig,
    pub delay: DelayModelConfig,
}
impl Default for TimingSettings {
    fn default() -> Self {
        Self {
            majsoul: Default::default(),
            delay: Default::default(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct TeacherSettings {
    pub session: SessionConfig,
    pub timing: TimingSettings,
    pub defaults: TimingSettings,
}
impl TeacherSettings {
    fn from_config(config: &AppConfig) -> Self {
        Self {
            session: config.autoplay.session,
            timing: TimingSettings {
                majsoul: config.autoplay.majsoul.clone(),
                delay: config.autoplay.delay.clone(),
            },
            defaults: Default::default(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatch {
    pub session: Option<SessionConfig>,
    pub timing: Option<TimingSettings>,
}
fn merge_settings(current: &AppConfig, patch: SettingsPatch) -> Result<AppConfig, String> {
    let mut next = current.clone();
    if let Some(session) = patch.session {
        next.autoplay.session = session;
    }
    if let Some(timing) = patch.timing {
        let m = &timing.majsoul;
        let d = &timing.delay;
        let millis = [
            m.pre_click_delay_min_ms,
            m.pre_click_delay_max_ms,
            m.inter_click_delay_ms,
            m.hover_delay_ms,
            m.click_hold_ms,
            m.verify_input_ms,
            m.dealer_first_discard_extra_delay_ms,
            d.min_delay_ms,
            d.min_button_delay_ms,
        ];
        if millis.iter().any(|&n| n > 60000)
            || m.pre_click_delay_min_ms > m.pre_click_delay_max_ms
            || m.click_retries > 10
            || m.reload_after_failures > 20
        {
            return Err(
                "等待时间须为 0–60000 毫秒，下限不能超过上限；重试最多 10 次，失败恢复最多 20 次"
                    .into(),
            );
        }
        next.autoplay.majsoul = timing.majsoul;
        next.autoplay.delay = timing.delay;
    }
    Ok(next)
}
fn trusted(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == LABEL || webview.label() == "main" {
        Ok(())
    } else {
        Err("untrusted webview".into())
    }
}
#[tauri::command]
pub async fn get_teacher_settings(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<TeacherSettings, String> {
    trusted(&webview)?;
    Ok(TeacherSettings::from_config(&*state.config.read().await))
}
#[tauri::command]
pub async fn save_teacher_settings(
    webview: tauri::Webview,
    patch: SettingsPatch,
    state: State<'_, AppState>,
) -> Result<TeacherSettings, String> {
    trusted(&webview)?;
    let mut current = state.config.write().await;
    let next = merge_settings(&current, patch)?;
    super::commands::persist_config(&next, &state.config_path).map_err(|e| e.to_string())?;
    // No capture restart, master-switch change or cancellation of the current decision.
    *current = next;
    Ok(TeacherSettings::from_config(&current))
}
#[tauri::command]
pub async fn open_settings(
    webview: tauri::Webview,
    app: AppHandle,
    tab: Option<String>,
) -> Result<(), String> {
    trusted(&webview)?;
    tracing::info!(target: "akagi::settings", "opening settings accessory window");
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let tab = match tab.as_deref() {
        Some("updates") => "updates",
        Some("history") => "history",
        Some("analysis") => "analysis",
        Some("overview") => "overview",
        Some("appearance") => "appearance",
        _ => "autoplay",
    };
    app.run_on_main_thread(move || {
        let result = (|| -> anyhow::Result<()> {
            if let Some(w) = handle.get_webview_window(LABEL) {
                w.eval(format!(
                    "window.dispatchEvent(new CustomEvent('show-settings-tab', {{detail: {}}}))",
                    serde_json::to_string(tab)?
                ))?;
                w.show()?;
                w.set_focus()?;
                return Ok(());
            }
            // Main owns multiple webviews after embedding the game, so
            // get_webview_window("main") deliberately returns None in Tauri.
            let main = handle
                .get_window("main")
                .ok_or_else(|| anyhow::anyhow!("主窗口不存在"))?;
            let builder = WebviewWindowBuilder::new(
                &handle,
                LABEL,
                WebviewUrl::App(format!("index.html?settingsTab={tab}").into()),
            )
            .title("Akagi 教师版 · 设置")
            .inner_size(780.0, 640.0)
            .min_inner_size(660.0, 460.0)
            .resizable(true)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true);
            #[cfg(windows)]
            // An owned top-level window floats above the game's native webview.
            // parent_raw would set WS_CHILD, clipping settings inside main.
            let builder = builder.owner_raw(main.hwnd()?);
            #[cfg(not(windows))]
            let _ = main;
            let window = builder.center().build()?;
            window.show()?;
            window.set_focus()?;
            tracing::info!(target: "akagi::settings", "settings accessory window opened");
            Ok(())
        })()
        .map_err(|e| format!("打开设置失败：{e:#}"));
        if let Err(error) = &result {
            tracing::error!(target: "akagi::settings", %error, "could not open settings");
        }
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_preserves_live_switch_and_unrelated_config() {
        for enabled in [false, true] {
            let mut current = AppConfig::default();
            current.autoplay.enabled = enabled;
            current.bot.active_4p = "keep-model".into();
            current.capture.chromium.start_url = "keep-url".into();
            let before = serde_json::to_value(&current).unwrap();
            let mut timing = TimingSettings::default();
            timing.majsoul.hover_delay_ms = 350;
            let merged = merge_settings(
                &current,
                SettingsPatch {
                    session: None,
                    timing: Some(timing),
                },
            )
            .unwrap();
            let mut after = serde_json::to_value(&merged).unwrap();
            after["autoplay"]["majsoul"]["hover_delay_ms"] =
                before["autoplay"]["majsoul"]["hover_delay_ms"].clone();
            assert_eq!(before, after);
        }
    }
    #[test]
    fn invalid_timing_is_rejected_without_mutating_config() {
        let current = AppConfig::default();
        let mut timing = TimingSettings::default();
        timing.majsoul.pre_click_delay_min_ms = 4000;
        assert!(merge_settings(
            &current,
            SettingsPatch {
                session: None,
                timing: Some(timing)
            }
        )
        .is_err());
        assert_eq!(current.autoplay.majsoul.pre_click_delay_min_ms, 1000);
    }
    #[test]
    fn patch_rejects_hidden_settings_and_master_switch() {
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"enabled":false}"#).is_err());
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"bot":{}}"#).is_err());
    }
}
