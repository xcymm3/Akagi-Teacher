//! Ranked lobby/result loop. Master-gated; no changes to model/teacher choices.
//! Navigation order/anchors are adapted from static AkagiMS 1.3.2 analysis.
use super::{
    cdp_input::{dispatch_click_shaped_gated, evaluate_canvas_rect},
    context::AutoplayContext,
};
use crate::{
    bridge::majsoul::parser::{MessageType, ParsedMessage},
    config::{AppConfig, Platform, RankedMode, RankedRoom, SessionConfig},
    schema::{mjai::GameEndReason, MjaiEvent},
};
use anyhow::{Context, Result};
use chromiumoxide::{
    cdp::browser_protocol::input::{DispatchMouseEventParams, DispatchMouseEventType},
    page::Page,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{atomic::Ordering, Arc, RwLock as StdRwLock},
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const SCRIPT: &str = include_str!("session_page.js");
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WirePhase {
    #[default]
    Unknown,
    Lobby,
    Queued,
    Matching,
    Playing,
    HandResult,
    GameResult,
}
#[derive(Debug, Clone, Default)]
pub struct WireState {
    pub revision: u64,
    pub phase: WirePhase,
    pub queue_sent: u64,
    pub account: Option<u64>,
    pub level: Option<u32>,
    pub lobby_at: Option<Instant>,
    pub games: u32,
    pub error: Option<String>,
}
impl WireState {
    fn phase(&mut self, phase: WirePhase) {
        self.phase = phase;
        self.revision = self.revision.wrapping_add(1);
    }
}
#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionStatus {
    pub phase: String,
    pub message: String,
    pub completed: u32,
}
#[derive(Default)]
pub struct SessionSignals {
    wire: StdRwLock<WireState>,
    status: StdRwLock<SessionStatus>,
}
impl SessionSignals {
    pub fn snapshot(&self) -> WireState {
        self.wire.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn status(&self) -> SessionStatus {
        self.status
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn status_set(&self, phase: &str, message: &str) {
        let mut s = self.status.write().unwrap_or_else(|e| e.into_inner());
        if s.phase != phase || s.message != message {
            tracing::info!(phase, message, "autoplay session");
        }
        *s = SessionStatus {
            phase: phase.into(),
            message: message.into(),
            completed: self.snapshot().games,
        };
    }
    fn lobby_confirmed(&self, revision: u64) {
        let mut s = self.wire.write().unwrap_or_else(|e| e.into_inner());
        if s.revision == revision
            && !matches!(
                s.phase,
                WirePhase::Playing | WirePhase::Matching | WirePhase::Queued
            )
        {
            s.error = None;
            s.phase(WirePhase::Lobby);
        }
    }
    pub fn observe_wire(&self, msg: &ParsedMessage) {
        let mut s = self.wire.write().unwrap_or_else(|e| e.into_inner());
        let name = msg.method_name.as_ref();
        let ok = msg
            .payload
            .pointer("/error/code")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            == 0;
        if name.starts_with(".lq.Lobby.") && msg.msg_type == MessageType::Response {
            s.lobby_at = Some(Instant::now());
        }
        if msg.msg_type == MessageType::Response
            && ok
            && matches!(
                name,
                ".lq.Lobby.login" | ".lq.Lobby.oauth2Login" | ".lq.Lobby.emailLogin"
            )
        {
            s.account = msg
                .payload
                .get("account_id")
                .and_then(|v| v.as_u64())
                .or_else(|| {
                    msg.payload
                        .pointer("/account/account_id")
                        .and_then(|v| v.as_u64())
                });
            s.level = msg
                .payload
                .pointer("/account/level/id")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
        }
        if msg.msg_type == MessageType::Response && ok && name == ".lq.Lobby.fetchAccountInfo" {
            let id = msg
                .payload
                .pointer("/account/account_id")
                .and_then(|v| v.as_u64());
            if id.is_some() && id == s.account {
                s.level = msg
                    .payload
                    .pointer("/account/level/id")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32);
            }
        }
        match (msg.msg_type, name) {
            (MessageType::Request, ".lq.Lobby.startUnifiedMatch") => {
                s.queue_sent += 1;
                s.error = None;
                s.phase(WirePhase::Queued);
            }
            (MessageType::Response, ".lq.Lobby.startUnifiedMatch") if !ok => {
                s.error = Some("排队请求被服务器拒绝，请检查房间和账号状态".into());
                s.phase(WirePhase::Lobby);
            }
            (MessageType::Response, ".lq.Lobby.cancelUnifiedMatch") if ok => {
                s.phase(WirePhase::Lobby);
            }
            (MessageType::Notify, ".lq.NotifyMatchGameStart")
            | (MessageType::Request, ".lq.FastTest.authGame") => {
                s.phase(WirePhase::Matching);
            }
            _ => {}
        }
    }
    pub fn observe_mjai(&self, ev: &MjaiEvent) {
        let mut s = self.wire.write().unwrap_or_else(|e| e.into_inner());
        match ev {
            MjaiEvent::StartGame { .. } | MjaiEvent::StartKyoku { .. } => {
                s.error = None;
                s.phase(WirePhase::Playing);
            }
            MjaiEvent::EndKyoku if s.phase != WirePhase::GameResult => {
                s.phase(WirePhase::HandResult)
            }
            MjaiEvent::EndGame {
                reason: GameEndReason::Confirmed,
                ..
            } => {
                if s.phase != WirePhase::GameResult {
                    s.games += 1;
                    s.phase(WirePhase::GameResult);
                }
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct View {
    #[serde(default)]
    pub doc: String,
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub hall: bool,
    #[serde(default)]
    pub confirm: bool,
}
#[derive(Debug, Clone, PartialEq)]
enum Step {
    Click(f64, f64),
    Scroll,
    Pause(u64),
}
#[derive(Debug, Clone, PartialEq)]
enum Effect {
    Click(f64, f64),
    Scroll,
    Reload,
    Lobby,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Waiting,
    Navigating,
    AwaitQueue,
    Queued,
    Playing,
    Result,
    Recovering,
    Paused,
}
struct Machine {
    stage: Stage,
    epoch: u64,
    revision: u64,
    doc: String,
    due: u64,
    hall_since: Option<u64>,
    confirm_since: Option<u64>,
    steps: Vec<Step>,
    index: usize,
    failures: u8,
    result_start: u64,
    result_clicks: u8,
    whole: bool,
    message: &'static str,
}
impl Default for Machine {
    fn default() -> Self {
        Self {
            stage: Stage::Waiting,
            epoch: u64::MAX,
            revision: u64::MAX,
            doc: String::new(),
            due: 0,
            hall_since: None,
            confirm_since: None,
            steps: vec![],
            index: 0,
            failures: 0,
            result_start: 0,
            result_clicks: 0,
            whole: false,
            message: "等待大厅",
        }
    }
}
fn resolved_room(request: RankedRoom, level: Option<u32>) -> Option<RankedRoom> {
    let class = level
        .filter(|id| id / 10000 == 1)
        .map(|id| id / 100 % 100)?;
    let highest = match class {
        1 => RankedRoom::Bronze,
        2 => RankedRoom::Silver,
        3 => RankedRoom::Gold,
        4 => RankedRoom::Jade,
        5..=7 => RankedRoom::Throne,
        _ => return None,
    };
    let available = match request {
        RankedRoom::Auto => false,
        RankedRoom::Bronze => class <= 2,
        RankedRoom::Silver => (2..=3).contains(&class),
        RankedRoom::Gold => (3..=4).contains(&class),
        RankedRoom::Jade => (4..=7).contains(&class),
        RankedRoom::Throne => class >= 5,
    };
    Some(if available { request } else { highest })
}
fn navigation(room: RankedRoom, mode: RankedMode) -> Vec<Step> {
    let mut steps = vec![Step::Click(11.4, 2.6), Step::Pause(1800)];
    if matches!(room, RankedRoom::Jade | RankedRoom::Throne) {
        steps.extend([Step::Scroll, Step::Pause(600)]);
    }
    let y = match room {
        RankedRoom::Bronze => 3.4,
        RankedRoom::Silver => 4.9,
        RankedRoom::Gold => 6.3,
        RankedRoom::Jade => 5.3,
        RankedRoom::Throne => 6.7,
        RankedRoom::Auto => unreachable!(),
    };
    steps.extend([
        Step::Click(11.6, y),
        Step::Pause(1400),
        Step::Click(11.6, if mode == RankedMode::East4 { 3.4 } else { 4.9 }),
    ]);
    steps
}
impl Machine {
    fn skipped(&mut self, now: u64) {
        if self.stage == Stage::Navigating {
            self.index = self.index.saturating_sub(1);
        }
        if self.stage == Stage::Result {
            self.result_clicks = self.result_clicks.saturating_sub(1);
        }
        self.due = now + 400;
        self.message = "等待页面可操作，尚未执行点击";
    }
    fn recover(&mut self, now: u64) -> Option<Effect> {
        self.failures += 1;
        if self.failures >= 3 {
            self.stage = Stage::Paused;
            self.message = "连续对局已暂停：页面没有进展，请检查后重新开启自动打牌";
            None
        } else {
            self.stage = Stage::Recovering;
            self.due = now + 30000;
            self.message = "正在刷新并恢复页面";
            Some(Effect::Reload)
        }
    }
    fn tick(
        &mut self,
        enabled: bool,
        epoch: u64,
        now: u64,
        wire: &WireState,
        view: &View,
        cfg: SessionConfig,
    ) -> Option<Effect> {
        if !enabled {
            *self = Self::default();
            self.message = "自动打牌已关闭";
            return None;
        }
        if epoch != self.epoch {
            *self = Self::default();
            self.epoch = epoch;
        }
        if self.stage == Stage::Paused {
            return None;
        }
        if let Some(_) = &wire.error {
            self.stage = Stage::Paused;
            self.message = "排队请求被拒绝，请检查房间和账号状态后重新开启";
            return None;
        }
        if wire.revision != self.revision {
            self.revision = wire.revision;
            self.hall_since = None;
            self.confirm_since = None;
            match wire.phase {
                WirePhase::Playing | WirePhase::Matching => {
                    self.stage = Stage::Playing;
                    self.due = now + 60000;
                    self.message = if wire.phase == WirePhase::Matching {
                        "匹配成功，等待进入对局"
                    } else {
                        "对局中：由原有自动出牌与教师决策接管"
                    };
                    self.failures = 0;
                }
                WirePhase::Queued => {
                    self.stage = Stage::Queued;
                    self.due = now + 360000;
                    self.message = "正在排队，等待匹配";
                }
                WirePhase::HandResult | WirePhase::GameResult => {
                    self.stage = Stage::Result;
                    self.result_start = now;
                    self.due = now + 1500;
                    self.result_clicks = 0;
                    self.whole = wire.phase == WirePhase::GameResult;
                    self.message = "正在处理结算";
                }
                WirePhase::Lobby | WirePhase::Unknown => {
                    self.stage = Stage::Waiting;
                    self.message = "等待大厅就绪";
                }
            }
        }
        if !view.doc.is_empty() && view.doc != self.doc {
            self.doc = view.doc.clone();
            self.hall_since = None;
            self.confirm_since = None;
            if matches!(self.stage, Stage::Navigating | Stage::AwaitQueue) {
                self.stage = Stage::Waiting;
                self.due = now + 2000;
            }
            if self.stage == Stage::Recovering
                && !matches!(
                    wire.phase,
                    WirePhase::Queued | WirePhase::Matching | WirePhase::Playing
                )
            {
                self.stage = Stage::Waiting;
                self.due = now + 2000;
            }
        }
        let lobby_fresh = wire
            .lobby_at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(30));
        let hall_ready = if view.supported && view.hall && lobby_fresh {
            now.saturating_sub(*self.hall_since.get_or_insert(now)) >= 2000
        } else {
            self.hall_since = None;
            false
        };
        if !view.confirm {
            self.confirm_since = None;
        }
        let confirm_ready = view.supported
            && view.confirm
            && now.saturating_sub(*self.confirm_since.get_or_insert(now)) >= 800;
        match self.stage {
            Stage::Paused => None,
            Stage::Playing => {
                if wire.phase == WirePhase::Matching && now >= self.due {
                    self.recover(now)
                } else {
                    None
                }
            }
            Stage::Queued => {
                if now >= self.due {
                    self.message = "匹配等待过久，正在恢复";
                    self.recover(now)
                } else {
                    None
                }
            }
            Stage::Recovering => {
                if now >= self.due {
                    self.recover(now)
                } else {
                    None
                }
            }
            Stage::Waiting => {
                if !hall_ready || now < self.due {
                    self.message = "等待登录并进入大厅";
                    return None;
                }
                if wire.phase != WirePhase::Lobby {
                    return Some(Effect::Lobby);
                }
                let Some(room) = resolved_room(cfg.room, wire.level) else {
                    self.message = "等待本账号四麻段位信息，请先登录";
                    return None;
                };
                self.steps = navigation(room, cfg.mode);
                self.index = 0;
                self.stage = Stage::Navigating;
                self.due = now;
                self.message = "正在选择房间并排队";
                None
            }
            Stage::Navigating => {
                if now < self.due || !view.supported {
                    return None;
                }
                if self.index == self.steps.len() {
                    self.stage = Stage::AwaitQueue;
                    self.due = now + 10000;
                    self.message = "等待排队请求确认";
                    return None;
                }
                let step = self.steps[self.index].clone();
                self.index += 1;
                match step {
                    Step::Click(x, y) => Some(Effect::Click(x, y)),
                    Step::Scroll => Some(Effect::Scroll),
                    Step::Pause(ms) => {
                        self.due = now + ms;
                        None
                    }
                }
            }
            Stage::AwaitQueue => {
                if now >= self.due {
                    self.recover(now)
                } else {
                    None
                }
            }
            Stage::Result => {
                if self.whole && hall_ready {
                    self.stage = Stage::Waiting;
                    return Some(Effect::Lobby);
                }
                // The remaining result controls are client-version dependent. After
                // a confirmed match end, reconnect into the known lobby rather than
                // guessing between leave/rematch buttons. In-hand reload uses restore.
                if (self.whole && now - self.result_start >= 12000)
                    || (!self.whole && now - self.result_start >= 25000)
                {
                    return self.recover(now);
                }
                if now >= self.due && confirm_ready && self.result_clicks < 4 {
                    self.result_clicks += 1;
                    self.due = now + 3000;
                    return Some(Effect::Click(14.59, 8.37));
                }
                None
            }
        }
    }
}

pub async fn install(page: &Page) -> Result<()> {
    tokio::time::timeout(
        Duration::from_millis(800),
        page.evaluate_on_new_document(SCRIPT),
    )
    .await??;
    tokio::time::timeout(Duration::from_millis(800), page.evaluate(SCRIPT)).await??;
    Ok(())
}
async fn observe(page: &Page) -> Result<View> {
    let answer = tokio::time::timeout(
        Duration::from_millis(1100),
        page.evaluate(
            "(async()=>{const s=window.__akagiTeacherSession;return s?await s.observe():{};})()",
        ),
    )
    .await??;
    serde_json::from_value(answer.value().cloned().unwrap_or_default())
        .context("decode ranked page observations")
}
async fn current(
    cfg: &Arc<RwLock<AppConfig>>,
    ctx: &AutoplayContext,
    epoch: u64,
    revision: u64,
) -> bool {
    let c = cfg.read().await;
    c.autoplay.enabled
        && c.platform.kind == Platform::Majsoul
        && ctx.autoplay_epoch.load(Ordering::SeqCst) == epoch
        && ctx.session.snapshot().revision == revision
}
async fn execute(
    effect: Effect,
    page: &Page,
    view: &View,
    cfg: &Arc<RwLock<AppConfig>>,
    ctx: &AutoplayContext,
    epoch: u64,
    revision: u64,
) -> Result<bool> {
    let _owner = ctx.input_lock.lock().await;
    if !current(cfg, ctx, epoch, revision).await {
        return Ok(false);
    }
    if effect == Effect::Lobby {
        ctx.session.lobby_confirmed(revision);
        return Ok(true);
    }
    if effect == Effect::Reload {
        // Recheck after waiting for input ownership; never reload a new game.
        page.reload().await?;
        *ctx.canvas_rect.write().await = None;
        return Ok(true);
    }
    let fresh = observe(page).await?;
    if fresh.doc != view.doc || !fresh.supported || !current(cfg, ctx, epoch, revision).await {
        return Ok(false);
    }
    let (x, y) = match effect {
        Effect::Click(x, y) => (x, y),
        Effect::Scroll => (11.6, 5.0),
        _ => unreachable!(),
    };
    if ctx.session.snapshot().phase == WirePhase::GameResult
        || ctx.session.snapshot().phase == WirePhase::HandResult
    {
        if !fresh.confirm {
            return Ok(false);
        }
    }
    let expression=format!("(()=>{{const s=window.__akagiTeacherSession;return !!s&&s.doc==={}&&s.clear({x},{y});}})()",serde_json::to_string(&view.doc)?);
    let clear = page
        .evaluate(expression.clone())
        .await?
        .value()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !clear || !current(cfg, ctx, epoch, revision).await {
        return Ok(false);
    }
    let rect = evaluate_canvas_rect(page).await?;
    let (px, py) = rect.pixel(x, y);
    if !rect.contains(px, py) {
        return Ok(false);
    }
    if effect == Effect::Scroll {
        let args = DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MouseWheel)
            .x(px)
            .y(py)
            .delta_x(0.0)
            .delta_y(650.0)
            .build()
            .map_err(|e| anyhow::anyhow!("wheel: {e}"))?;
        if !current(cfg, ctx, epoch, revision).await {
            return Ok(false);
        }
        page.execute(args).await?;
    } else {
        let pressed = dispatch_click_shaped_gated(
            page,
            px,
            py,
            200,
            80,
            false,
            Some(Box::pin(async {
                if !current(cfg, ctx, epoch, revision).await {
                    return false;
                }
                let Ok(actual) = evaluate_canvas_rect(page).await else {
                    return false;
                };
                if actual != rect {
                    return false;
                }
                let Ok(answer) = page.evaluate(expression.clone()).await else {
                    return false;
                };
                answer.value().and_then(|v| v.as_bool()) == Some(true)
                    && current(cfg, ctx, epoch, revision).await
            })),
        )
        .await;
        if let Err(error) = pressed {
            if error.is::<super::cdp_input::InputCancelled>() {
                return Ok(false);
            }
            return Err(error);
        }
        // A final gate can cancel after hover. Check the page again before
        // considering the navigation step dispatched.
        if !current(cfg, ctx, epoch, revision).await {
            return Ok(false);
        }
    }
    Ok(true)
}
pub async fn run(cfg: Arc<RwLock<AppConfig>>, ctx: Arc<AutoplayContext>) {
    let mut machine = Machine::default();
    let start = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(400));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let (enabled, settings) = {
            let c = cfg.read().await;
            (
                c.autoplay.enabled && c.platform.kind == Platform::Majsoul,
                c.autoplay.session,
            )
        };
        let epoch = ctx.autoplay_epoch.load(Ordering::SeqCst);
        let now = start.elapsed().as_millis() as u64;
        if !enabled {
            machine.tick(
                false,
                epoch,
                now,
                &ctx.session.snapshot(),
                &View::default(),
                settings,
            );
            ctx.session.status_set("off", "自动打牌已关闭");
            continue;
        }
        let page = ctx.page.read().await.clone();
        let Some(page) = page else {
            ctx.session.status_set("waiting", "等待连接雀魂页面");
            continue;
        };
        let view = match observe(&page).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("session observation: {e:#}");
                View::default()
            }
        };
        let wire = ctx.session.snapshot();
        if let Some(effect) = machine.tick(true, epoch, now, &wire, &view, settings) {
            tracing::debug!(?effect, revision = wire.revision, "ranked loop action");
            match execute(effect, &page, &view, &cfg, &ctx, epoch, wire.revision).await {
                Ok(false) => machine.skipped(now),
                Ok(true) => {}
                Err(e) => {
                    tracing::warn!("ranked loop input failed: {e:#}");
                    if current(&cfg, &ctx, epoch, wire.revision).await {
                        if let Some(effect) = machine.recover(now) {
                            let _ = execute(effect, &page, &view, &cfg, &ctx, epoch, wire.revision)
                                .await;
                        }
                    }
                }
            }
        }
        ctx.session.status_set(
            if machine.stage == Stage::Paused {
                "paused"
            } else {
                "running"
            },
            machine.message,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hall() -> View {
        View {
            doc: "page1".into(),
            supported: true,
            hall: true,
            confirm: false,
        }
    }
    fn lobby() -> WireState {
        WireState {
            phase: WirePhase::Lobby,
            level: Some(10301),
            lobby_at: Some(Instant::now()),
            ..Default::default()
        }
    }
    fn start(m: &mut Machine, w: &WireState) {
        assert_eq!(
            m.tick(true, 1, 0, w, &hall(), SessionConfig::default()),
            None
        );
        assert_eq!(
            m.tick(true, 1, 2500, w, &hall(), SessionConfig::default()),
            None
        );
        assert_eq!(m.stage, Stage::Navigating);
    }
    #[tokio::test]
    async fn final_input_gate_rejects_disabled_stale_epoch_or_changed_protocol() {
        let mut settings = AppConfig::default();
        settings.autoplay.enabled = true;
        let cfg = Arc::new(RwLock::new(settings));
        let ctx = AutoplayContext::default();
        assert!(current(&cfg, &ctx, 0, 0).await);
        cfg.write().await.autoplay.enabled = false;
        assert!(!current(&cfg, &ctx, 0, 0).await);
        cfg.write().await.autoplay.enabled = true;
        ctx.autoplay_epoch.fetch_add(1, Ordering::SeqCst);
        assert!(!current(&cfg, &ctx, 0, 0).await);
        ctx.session.observe_mjai(&MjaiEvent::EndKyoku);
        assert!(!current(&cfg, &ctx, 1, 0).await);
    }
    #[test]
    fn master_switch_cancels_navigation_and_epoch_discards_pending_steps() {
        let mut m = Machine::default();
        let w = lobby();
        start(&mut m, &w);
        assert_eq!(
            m.tick(true, 1, 2900, &w, &hall(), SessionConfig::default()),
            Some(Effect::Click(11.4, 2.6))
        );
        assert_eq!(
            m.tick(false, 2, 3000, &w, &hall(), SessionConfig::default()),
            None
        );
        assert_eq!(m.stage, Stage::Waiting);
        assert_eq!(
            m.tick(true, 3, 3100, &w, &hall(), SessionConfig::default()),
            None
        );
        assert_eq!(m.index, 0);
    }
    #[test]
    fn master_off_never_acts_in_any_phase() {
        for phase in [
            WirePhase::Lobby,
            WirePhase::Queued,
            WirePhase::Matching,
            WirePhase::Playing,
            WirePhase::HandResult,
            WirePhase::GameResult,
        ] {
            let mut m = Machine::default();
            let mut w = lobby();
            w.phase = phase;
            let view = View {
                confirm: true,
                ..hall()
            };
            for now in [0, 5000, 30000, 400000] {
                assert_eq!(
                    m.tick(false, 1, now, &w, &view, SessionConfig::default()),
                    None
                );
            }
        }
    }
    #[test]
    fn an_obscured_page_does_not_consume_a_navigation_step() {
        let mut m = Machine::default();
        let w = lobby();
        start(&mut m, &w);
        let first = m.tick(true, 1, 2900, &w, &hall(), SessionConfig::default());
        m.skipped(2900);
        assert_eq!(
            m.tick(true, 1, 3400, &w, &hall(), SessionConfig::default()),
            first
        );
    }
    #[test]
    fn queue_request_interrupts_click_chain_and_prevents_duplicate_queue() {
        let mut m = Machine::default();
        let mut w = lobby();
        start(&mut m, &w);
        w.phase = WirePhase::Queued;
        w.revision += 1;
        w.queue_sent += 1;
        for now in [3000, 10000, 200000] {
            assert_eq!(
                m.tick(true, 1, now, &w, &hall(), SessionConfig::default()),
                None
            );
            assert_eq!(m.stage, Stage::Queued);
        }
    }
    #[test]
    fn needs_both_visual_lobby_and_recent_wire_evidence_and_rank() {
        let mut w = lobby();
        w.lobby_at = None;
        let mut m = Machine::default();
        for now in [0, 3000, 5000] {
            assert_eq!(
                m.tick(true, 1, now, &w, &hall(), SessionConfig::default()),
                None
            );
            assert_eq!(m.stage, Stage::Waiting);
        }
        w.lobby_at = Some(Instant::now());
        w.level = None;
        for now in [6000, 9000] {
            m.tick(true, 1, now, &w, &hall(), SessionConfig::default());
        }
        assert_eq!(m.stage, Stage::Waiting);
    }
    #[test]
    fn only_protocol_end_opens_result_controls_and_new_hand_cancels_them() {
        let s = SessionSignals::default();
        let mut m = Machine::default();
        let mut view = hall();
        view.hall = false;
        view.confirm = true;
        let mut w = lobby();
        w.phase = WirePhase::Playing;
        for now in [0, 5000] {
            assert_eq!(
                m.tick(true, 1, now, &w, &view, SessionConfig::default()),
                None
            );
        }
        s.observe_mjai(&MjaiEvent::EndKyoku);
        w = s.snapshot();
        m.tick(true, 1, 6000, &w, &view, SessionConfig::default());
        assert_eq!(
            m.tick(true, 1, 8000, &w, &view, SessionConfig::default()),
            Some(Effect::Click(14.59, 8.37))
        );
        w.phase = WirePhase::Playing;
        w.revision += 1;
        assert_eq!(
            m.tick(true, 1, 12000, &w, &view, SessionConfig::default()),
            None
        );
        assert_eq!(s.snapshot().games, 0);
    }
    #[test]
    fn match_end_can_recover_to_lobby_but_termination_never_authorizes_requeue() {
        let s = SessionSignals::default();
        s.observe_mjai(&MjaiEvent::EndGame {
            reason: GameEndReason::Terminated,
            final_scores: None,
            final_ranks: None,
        });
        assert_eq!(s.snapshot().phase, WirePhase::Unknown);
        s.observe_mjai(&MjaiEvent::confirmed_game(None, None));
        s.observe_mjai(&MjaiEvent::confirmed_game(None, None));
        assert_eq!(s.snapshot().games, 1);
        let mut m = Machine::default();
        let w = s.snapshot();
        assert_eq!(
            m.tick(true, 1, 0, &w, &View::default(), SessionConfig::default()),
            None
        );
        assert_eq!(
            m.tick(
                true,
                1,
                13000,
                &w,
                &View::default(),
                SessionConfig::default()
            ),
            Some(Effect::Reload)
        );
        assert_eq!(m.stage, Stage::Recovering);
    }
    #[test]
    fn navigation_timeout_is_bounded_and_requires_a_restart_after_three_failures() {
        let mut m = Machine::default();
        let w = lobby();
        start(&mut m, &w);
        m.index = m.steps.len();
        m.tick(true, 1, 3000, &w, &hall(), SessionConfig::default());
        assert_eq!(
            m.tick(true, 1, 14000, &w, &hall(), SessionConfig::default()),
            Some(Effect::Reload)
        );
        assert_eq!(m.recover(45000), Some(Effect::Reload));
        assert_eq!(m.recover(76000), None);
        assert_eq!(m.stage, Stage::Paused);
        assert_eq!(
            m.tick(true, 1, 90000, &w, &hall(), SessionConfig::default()),
            None
        );
    }
    #[test]
    fn room_selection_and_recovered_navigation_order() {
        assert_eq!(
            resolved_room(RankedRoom::Auto, Some(10302)),
            Some(RankedRoom::Gold)
        );
        assert_eq!(
            resolved_room(RankedRoom::Throne, Some(10302)),
            Some(RankedRoom::Gold)
        );
        assert_eq!(
            resolved_room(RankedRoom::Auto, Some(10401)),
            Some(RankedRoom::Jade)
        );
        assert_eq!(resolved_room(RankedRoom::Auto, Some(20302)), None);
        assert_eq!(
            navigation(RankedRoom::Jade, RankedMode::South4),
            vec![
                Step::Click(11.4, 2.6),
                Step::Pause(1800),
                Step::Scroll,
                Step::Pause(600),
                Step::Click(11.6, 5.3),
                Step::Pause(1400),
                Step::Click(11.6, 4.9)
            ]
        );
    }
    fn message(kind: MessageType, name: &str, payload: serde_json::Value) -> ParsedMessage {
        ParsedMessage {
            msg_type: kind,
            msg_id: Some(1),
            method_name: name.into(),
            payload,
        }
    }
    #[test]
    fn protocol_observer_keeps_own_rank_and_distinguishes_rejected_queue() {
        let s = SessionSignals::default();
        s.observe_wire(&message(
            MessageType::Response,
            ".lq.Lobby.oauth2Login",
            serde_json::json!({"account_id":8,"account":{"account_id":8,"level":{"id":10401}}}),
        ));
        s.observe_wire(&message(
            MessageType::Response,
            ".lq.Lobby.fetchAccountInfo",
            serde_json::json!({"account":{"account_id":9,"level":{"id":10101}}}),
        ));
        assert_eq!(s.snapshot().level, Some(10401));
        s.observe_wire(&message(
            MessageType::Request,
            ".lq.Lobby.startUnifiedMatch",
            serde_json::json!({}),
        ));
        assert_eq!(s.snapshot().phase, WirePhase::Queued);
        s.observe_wire(&message(
            MessageType::Response,
            ".lq.Lobby.startUnifiedMatch",
            serde_json::json!({"error":{"code":1}}),
        ));
        assert!(s.snapshot().error.is_some());
    }
}
