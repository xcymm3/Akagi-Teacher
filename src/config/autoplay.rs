use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AutoplayConfig {
    /// Master switch for game, lobby and result input. Passive observers may
    /// remain alive when disabled; they do not issue automatic actions.
    pub enabled: bool,
    /// Ranked lobby loop follows the master switch; no independent enable flag.
    pub session: SessionConfig,
    /// Per-platform autoplay knobs. Only the matching platform's section is
    /// consulted at runtime; the others sit dormant.
    pub majsoul: MajsoulAutoplayConfig,
    /// Pre-click delay model (platform-agnostic). See `autoplay::delay`.
    pub delay: DelayModelConfig,
}

/// Which delay policy drives autoplay. Exactly one is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DelayMode {
    /// The historical fixed model: `uniform(pre_click_delay_min_ms,
    /// pre_click_delay_max_ms)` plus the dealer-opening pad. Ignores the
    /// Lua script and the calibrated distributions.
    Legacy,
    /// The scriptable model: `delay.lua` next to the config file (auto-
    /// generated with the calibrated human-like default on first use,
    /// hot-reloaded on save). If the script fails, the built-in
    /// calibrated model runs instead.
    #[default]
    Lua,
}

/// Shape of the base thinking-time distribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DelayDistribution {
    /// `uniform(pre_click_delay_min_ms, pre_click_delay_max_ms)` — the
    /// historical Akagi behaviour.
    Uniform,
    /// Per-decision-kind log-normal over seconds (`exp(N(mu, sigma))`),
    /// clamped to the `[pre_click_delay_min_ms, pre_click_delay_max_ms]`
    /// window scaled by 0.5x/4x so the fat tail can exceed the old bounds
    /// without running away. Default: real players' think times are
    /// log-normal with sigma ~0.5–0.6 (measured from the server-side
    /// action clock of ranked game records).
    #[default]
    LogNormal,
}

/// Parameters of the built-in pre-click delay model (`autoplay::delay`).
///
/// The log-normal defaults are **calibrated against real ranked-game
/// records** (Throne-room 4p; think times measured on the server-side
/// action clock of decoded game records). Additive rule bonuses still
/// default to 0 — the calibrated per-kind distributions already encode
/// the human differences they were meant to approximate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DelayModelConfig {
    /// Which policy is active: `legacy` (old fixed model) or `lua`.
    pub mode: DelayMode,
    /// Minimum total thinking time per decision, ms. This is a
    /// functional floor, not a style knob: Mahjong Soul needs time to
    /// render tiles after the triggering frame, and a click issued
    /// before the UI exists is silently lost. Applies in every mode and
    /// cannot be undercut by the Lua script.
    pub min_delay_ms: u32,
    /// UI-readiness floor for decisions that click an **action button**
    /// (chi/pon/kan, ron/tsumo, riichi, skip, kyuushu, kita), ms. The
    /// buttons appear only after the triggering discard's animation and
    /// their own pop-in — noticeably later than hand tiles render — so
    /// they need a higher floor than plain discards. Applies in every
    /// mode and cannot be undercut by the Lua script.
    pub min_button_delay_ms: u32,
    /// Base distribution shape (built-in model; also the fallback when
    /// the Lua script fails).
    pub distribution: DelayDistribution,
    /// Per-decision-kind log-normal parameters `[mu, sigma]` in
    /// ln(seconds). Keys: `dahai_tedashi`, `dahai_tsumogiri`,
    /// `post_call_dahai`, `reach`, `claim`, `hora`. A missing key falls
    /// back to `dahai_tedashi`. Only used for `LogNormal`.
    pub lognormal: std::collections::BTreeMap<String, [f64; 2]>,
    /// Let a long-thought sample (one exceeding the soft cap) dip into
    /// the server's extra time pool even without a top-two near-tie.
    /// Real players do this routinely; the bank refills every kyoku.
    /// The spend stays bounded by `bank_use_fraction` /
    /// `bank_max_single_ms`. `false` restores the strict
    /// near-tie-only gate.
    pub bank_on_long_thought: bool,
    /// Extra target time when riichi can be declared this turn (a genuine
    /// decision), ms. 0 = off.
    pub riichi_extra_ms: u32,
    /// Extra target time when the action is a kan declaration, ms. 0 = off.
    pub kan_extra_ms: u32,
    /// Reserved headroom inside the server window for network RTT and
    /// scheduling jitter, ms. The soft cap is
    /// `time_fixed - safety_margin - click_overhead`.
    pub safety_margin_ms: u32,
    /// Fraction of the server's extra time pool (`time_add`) a single
    /// hard decision may spend when the model allows bank use.
    pub bank_use_fraction: f64,
    /// Absolute cap on extra-pool spend for a single decision, ms.
    pub bank_max_single_ms: u32,
    /// Static cap applied when no server budget is known (non-Majsoul
    /// platform, or before the first operation list), ms. 0 = no cap.
    pub no_budget_cap_ms: u32,
}

/// Calibrated per-kind log-normal parameters, ln(seconds).
///
/// Source: 30 Throne-room ranked 4p records (~21,500 decision windows),
/// think time on the server's game clock (includes each player's own
/// client→server latency — a bias in the human direction). Medians:
/// tedashi ≈2.2s, tsumogiri ≈1.55s, post-call discard ≈1.5s, riichi
/// declaration ≈2.7s, claim windows (mostly passes) ≈1.4s.
///
/// This flat table is the built-in fallback; the generated `delay.lua`
/// models the same data with more structure (routine-vs-think mixture,
/// tile class, defence reads, budget shaping).
fn default_lognormal() -> std::collections::BTreeMap<String, [f64; 2]> {
    [
        ("dahai_tedashi", [0.87, 0.62]),
        ("dahai_tsumogiri", [0.52, 0.53]),
        ("post_call_dahai", [0.52, 0.42]),
        ("reach", [1.10, 0.55]),
        ("claim", [0.26, 0.57]),
        ("hora", [0.15, 0.50]),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

impl Default for DelayModelConfig {
    fn default() -> Self {
        Self {
            mode: DelayMode::Lua,
            // Matches the historical uniform lower bound — the value the
            // old model implicitly relied on for UI readiness.
            min_delay_ms: 1000,
            // Buttons render after the discard animation + their own
            // pop-in; observed to still be missing at 1000ms on real
            // hardware.
            min_button_delay_ms: 1600,
            distribution: DelayDistribution::LogNormal,
            lognormal: default_lognormal(),
            bank_on_long_thought: true,
            riichi_extra_ms: 0,
            kan_extra_ms: 0,
            safety_margin_ms: 1000,
            bank_use_fraction: 0.25,
            bank_max_single_ms: 5000,
            // 15s static ceiling: far above anything the default
            // distribution produces, low enough to survive even a 5s+20
            // room's base window if the budget is somehow unknown.
            no_budget_cap_ms: 15_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MajsoulAutoplayConfig {
    /// Lower bound of the random pre-click delay (ms). The reference
    /// Akagi autoplay used `random.uniform(1.0, 3.0)` seconds; the same
    /// distribution is replicated here as `[1000, 3000]` ms by default.
    pub pre_click_delay_min_ms: u32,
    /// Upper bound of the random pre-click delay (ms).
    pub pre_click_delay_max_ms: u32,
    /// Inter-click delay between staged clicks within one action (e.g.
    /// reach button → riichi tile, or chi button → candidate select).
    pub inter_click_delay_ms: u32,
    /// How long to hover the mouse over a target before pressing.
    /// Empirically Laya's input system samples hover state before a
    /// mousedown registers a hit on the tile sprite — clicks issued
    /// without a hover delay (or shorter than ~100ms) get dropped on
    /// the floor. Default 200ms; do not lower below 100ms.
    pub hover_delay_ms: u32,
    /// How long to hold the mouse button down between mousePressed and
    /// mouseReleased. Non-zero so the engine doesn't collapse the pair
    /// into a single frame.
    pub click_hold_ms: u32,
    /// How long to wait for the client's own uplink command
    /// (`inputOperation` / `inputChiPengGang`) after a click sequence
    /// before treating the click as swallowed and pressing again, ms.
    /// `0` disables verification entirely.
    ///
    /// Checked by polling, so a click that worked costs nothing — only a
    /// genuinely lost one waits this out. Raising it is safer than
    /// lowering it: a retry that fires while the first press was merely
    /// slow presses a second time.
    pub verify_input_ms: u32,
    /// How many times a click sequence may be repeated when no input
    /// command follows it. `0` disables retrying (verification then only
    /// logs). Each retry re-checks that the decision window is still the
    /// one the plan was made for.
    pub click_retries: u32,
    /// Reload the game page after this many decisions in a row where the
    /// client accepted no input at all. `0` disables it.
    ///
    /// The client can end up in a state where presses on the action
    /// buttons stop registering and stay that way for the rest of the
    /// game — once it starts it does not recover on its own, and every
    /// remaining decision runs to timeout. A reload reconnects into the
    /// hand through the bridge's `GameRestore` path, so the cost is a
    /// reconnect rather than the game. Deliberately not 1: a single lost
    /// press is common enough and costs only that decision.
    pub reload_after_failures: u32,
    /// Extra delay tacked onto the dealer's first discard. Mahjong Soul
    /// plays a hand-sort animation when the dealer receives all 14 tiles
    /// at once; clicks issued during the animation are dropped. ~2s
    /// covers the animation across normal device speeds. Set to 0 to
    /// opt out (e.g. on a fast box where the animation finishes inside
    /// the regular pre-click delay anyway).
    pub dealer_first_discard_extra_delay_ms: u32,
}

impl Default for MajsoulAutoplayConfig {
    fn default() -> Self {
        Self {
            pre_click_delay_min_ms: 1000,
            pre_click_delay_max_ms: 3000,
            inter_click_delay_ms: 300,
            hover_delay_ms: 200,
            click_hold_ms: 100,
            verify_input_ms: 300,
            click_retries: 2,
            reload_after_failures: 3,
            dealer_first_discard_extra_delay_ms: 2000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pre-existing config written before the delay model existed has
    /// no `[autoplay.delay]` section — it must deserialize to the
    /// calibrated defaults, not zeros. Pins the container-level
    /// `#[serde(default)]` attributes against regression.
    #[test]
    fn missing_delay_section_gets_defaults() {
        let cfg: AutoplayConfig = toml::from_str("enabled = true").unwrap();
        let default = DelayModelConfig::default();
        assert_eq!(cfg.delay.mode, default.mode);
        assert_eq!(cfg.delay.min_delay_ms, default.min_delay_ms);
        assert_eq!(cfg.delay.min_button_delay_ms, default.min_button_delay_ms);
        assert_eq!(cfg.delay.lognormal, default.lognormal);
    }

    /// A partial `[delay]` table keeps its explicit values and fills
    /// everything else from the defaults.
    #[test]
    fn partial_delay_section_fills_remaining_defaults() {
        let cfg: AutoplayConfig = toml::from_str("[delay]\nmin_delay_ms = 5\n").unwrap();
        let default = DelayModelConfig::default();
        assert_eq!(cfg.delay.min_delay_ms, 5);
        assert_eq!(cfg.delay.mode, default.mode);
        assert_eq!(cfg.delay.min_button_delay_ms, default.min_button_delay_ms);
        assert!(!cfg.delay.lognormal.is_empty());
    }
}

/// Lobby choices used while the autoplay master switch is on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionConfig {
    pub room: RankedRoom,
    pub mode: RankedMode,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RankedRoom {
    #[default]
    Auto,
    Bronze,
    Silver,
    Gold,
    Jade,
    Throne,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RankedMode {
    East4,
    #[default]
    South4,
}
