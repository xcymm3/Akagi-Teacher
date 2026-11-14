//! Public-information flush defence. Policy weights are heuristics, not
//! calibrated probabilities. Never changes riichi flags or safety lifetimes.
use super::{
    data::{point, tenpai},
    tile::Tile34,
};
use crate::{
    game_state::snapshot::{GameStateSnapshot, MeldKind, PlayerSnapshot},
    schema::MjaiEvent,
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Watch,
    Suspected,
    High,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlushThreat {
    pub seat: u8,
    pub suit: String,
    pub level: Level,
    /// Upstream reference estimate, kept separate from the defensive override.
    pub tenpai_reference: f64,
}

fn suit(t: Tile34) -> Option<u8> {
    (t.idx() < 27).then_some(t.idx() / 9)
}

pub fn visible_dora(s: &GameStateSnapshot, p: &PlayerSnapshot) -> u32 {
    dora_count(s, p, false)
}

pub fn visible_open_dora(s: &GameStateSnapshot, p: &PlayerSnapshot) -> u32 {
    dora_count(s, p, true)
}

fn dora_count(s: &GameStateSnapshot, p: &PlayerSnapshot, open_only: bool) -> u32 {
    p.melds
        .iter()
        .filter(|m| !open_only || m.kind != MeldKind::Ankan)
        .flat_map(|m| &m.tiles)
        .map(|raw| {
            let Some(t) = Tile34::from_mjai(raw) else {
                return 0;
            };
            u32::from(raw.ends_with('r'))
                + s.dora_markers
                    .iter()
                    .filter(|raw| {
                        Tile34::from_mjai(raw).is_some_and(|m| {
                            let next = if s.num_players == 3 && m.idx() == 0 {
                                Tile34(8)
                            } else {
                                m.dora_next()
                            };
                            next == t
                        })
                    })
                    .count() as u32
        })
        .sum()
}

/// Matches Go CalcTenpaiRate: omit the immediate discard after the last call
/// from its post-call tedashi window. Incomplete histories use the table floor.
pub fn tenpai_reference(s: &GameStateSnapshot, p: &PlayerSnapshot, events: &[MjaiEvent]) -> f64 {
    if p.riichi_declared {
        return 100.0;
    }
    if !p.melds.iter().any(|m| m.kind != MeldKind::Ankan) {
        return p.river.len() as f64;
    }
    if p.melds.len() >= 4 {
        return 100.0;
    }
    let mut cuts = 0;
    let mut last = None;
    for e in events {
        match e {
            MjaiEvent::StartKyoku { .. } => {
                cuts = 0;
                last = None;
            }
            MjaiEvent::Dahai { actor, .. } if *actor == p.seat => cuts += 1,
            MjaiEvent::Chi { actor, .. }
            | MjaiEvent::Pon { actor, .. }
            | MjaiEvent::Daiminkan { actor, .. }
            | MjaiEvent::Ankan { actor, .. }
                if *actor == p.seat =>
            {
                last = Some(cuts)
            }
            _ => {}
        }
    }
    let tedashi = if cuts == p.river.len() {
        last.map(|n| p.river.iter().skip(n + 1).filter(|d| d.tedashi).count())
            .unwrap_or(0)
    } else {
        0
    };
    let rate = tenpai::rate(p.melds.len(), p.river.len(), tedashi);
    if s.num_players == 3 {
        tenpai::rate_3p(rate)
    } else {
        rate
    }
}

pub fn assess(s: &GameStateSnapshot, events: &[MjaiEvent]) -> Vec<FlushThreat> {
    s.players
        .iter()
        .filter(|p| Some(p.seat) != s.our_seat && !p.riichi_declared)
        .filter_map(|p| {
            let open = p.melds.iter().filter(|m| m.kind != MeldKind::Ankan).count();
            if open == 0 {
                return None;
            }
            let mut color = None;
            let mut numeric_open = false;
            // Include concealed kans as contradictory evidence; they do not
            // increase the open-meld count. Honor-only calls identify no suit.
            for m in &p.melds {
                for raw in &m.tiles {
                    let t = Tile34::from_mjai(raw)?;
                    if let Some(c) = suit(t) {
                        if color.is_some_and(|old| old != c) {
                            return None;
                        }
                        color = Some(c);
                        numeric_open |= m.kind != MeldKind::Ankan;
                    }
                }
            }
            if !numeric_open {
                return None;
            }
            let color = color?;
            let mut other = 0;
            let mut target_tedashi = 0;
            for d in p.river.iter().rev().take(6) {
                let c = suit(Tile34::from_mjai(&d.tile)?);
                other += usize::from(c.is_some_and(|c| c != color));
                target_tedashi += usize::from(c == Some(color) && d.tedashi);
            }
            let strong_river = p.river.len() >= 6 && other >= 4 && target_tedashi <= 1;
            let rate = tenpai_reference(s, p, events);
            let high = open >= 2
                && strong_river
                && ((open >= 3 && rate >= 60.0) || (p.river.len() >= 10 && rate >= 70.0));
            let level = if high {
                Level::High
            } else if open >= 2 && strong_river {
                Level::Suspected
            } else {
                Level::Watch
            };
            Some(FlushThreat {
                seat: p.seat,
                suit: ["m", "p", "s"][color as usize].into(),
                level,
                tenpai_reference: rate,
            })
        })
        .collect()
}

/// Reference loss of an open hand, including each actual exposed dora/red tile
/// once (a red tile that is also dora contributes both bonuses).
pub fn ordinary_loss(s: &GameStateSnapshot, p: &PlayerSnapshot) -> f64 {
    let loss = if p.riichi_declared {
        point::RON_POINT_RIICHI
    } else if p.melds.iter().any(|m| m.kind != MeldKind::Ankan) {
        point::open_ron_point_with_dora(visible_dora(s, p))
    } else {
        point::RON_POINT_DAMA
    };
    loss * if p.seat == s.oya { 1.5 } else { 1.0 }
}

/// Input risk already includes ordinary loss. Replace the flush branch's loss
/// by a ratio instead of multiplying the whole result by another point bonus.
/// Factors describe an intentionally conservative strategy, not deal-in rates.
pub fn adjust(
    s: &GameStateSnapshot,
    threat: Option<&FlushThreat>,
    rate: f64,
    loss: f64,
    risk: &mut [f64; 34],
) -> f64 {
    let Some(threat) = threat else { return rate };
    let weight = match threat.level {
        Level::Watch => return rate,
        Level::Suspected => 0.55,
        Level::High => 0.85,
    };
    let Some(p) = s.players.iter().find(|p| p.seat == threat.seat) else {
        return rate;
    };
    let color = match threat.suit.as_str() {
        "m" => 0,
        "p" => 1,
        "s" => 2,
        _ => return rate,
    };
    // +2 is a han-equivalent heuristic on the existing loss table, not a
    // claimed chinitsu or a precise score for the unknown concealed hand.
    let flush_loss = point::open_ron_point_with_dora(visible_dora(s, p) + 2)
        * if p.seat == s.oya { 1.5 } else { 1.0 };
    let loss_ratio = flush_loss.max(loss) / loss;
    let left = super::coach::unseen(s, s.our_seat.unwrap_or(0));
    let wind = 27 + (p.seat + s.num_players - s.oya) % s.num_players;
    for (i, r) in risk.iter_mut().enumerate() {
        let factor = if i < 27 {
            if i / 9 == color {
                2.0
            } else {
                0.15
            }
        } else if i >= 31
            || i == wind as usize
            || Tile34::from_mjai(&s.bakaze).is_some_and(|t| t.idx() as usize == i)
        {
            if left[i] >= 2 {
                1.8
            } else {
                1.4
            }
        } else {
            1.3
        };
        // True safe tiles stay zero, irrespective of suit or threat level.
        *r *= (1.0 - weight) + weight * factor * loss_ratio;
    }
    if threat.level == Level::High {
        100.0
    } else {
        rate
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn sample() -> GameStateSnapshot {
        let players: Vec<_> = (0..4).map(|seat| json!({
            "seat":seat, "tehai":if seat == 0 {vec!["2m","5m","8m","2p","5p","8p","2s","5s","8s","E","S","W","N"]} else {vec![]},
            "melds":[],"river":[],"score":25000,"riichi_declared":false,
            "riichi_stage":false,"double_riichi":false,"riichi_declaration_index":null,
            "kita_tiles":[],"drawn_tile":null
        })).collect();
        let mut s: GameStateSnapshot = serde_json::from_value(json!({
            "bakaze":"E","kyoku":1,"honba":0,"kyotaku":0,"oya":0,"current_player":0,
            "turn_count":24,"phase":"wait_act","is_done":false,"num_players":4,
            "players":players,"dora_markers":[],"our_seat":0
        }))
        .unwrap();
        s.players[2].melds = [vec!["1m","2m","3m"],vec!["4m","5m","6m"],vec!["P","P","P"]]
            .iter().enumerate().map(|(i, tiles)| serde_json::from_value(json!({
                "kind":if i == 2 {"pon"} else {"chi"},"tiles":tiles,"from_who":1,"called_tile":tiles[0]
            })).unwrap()).collect();
        river(&mut s, &["1p", "2p", "3p", "1s", "2s", "3s"]);
        s
    }
    pub(crate) fn river(s: &mut GameStateSnapshot, tiles: &[&str]) {
        s.players[2].river = tiles
            .iter()
            .map(|tile| {
                serde_json::from_value(json!({
                    "tile":tile,"tedashi":true,"is_riichi":false
                }))
                .unwrap()
            })
            .collect();
    }
    fn high(s: &GameStateSnapshot, events: &[MjaiEvent]) -> bool {
        assess(s, events)
            .iter()
            .any(|t| t.seat == 2 && t.level == Level::High)
    }

    #[test]
    fn three_calls_and_biased_river_are_high_without_dora_or_riichi() {
        let s = sample();
        let threats = assess(&s, &[]);
        assert_eq!(threats.len(), 1);
        assert_eq!(threats[0].suit, "m");
        assert_eq!(threats[0].level, Level::High);
        assert!((threats[0].tenpai_reference - 68.20).abs() < 1e-6);
        assert_eq!(visible_dora(&s, &s.players[2]), 0);
        assert!(!s.players[2].riichi_declared);
    }
    #[test]
    fn two_calls_require_late_turn_and_progress_not_just_matching_suits() {
        let mut s = sample();
        s.players[2].melds.pop();
        assert_eq!(assess(&s, &[])[0].level, Level::Suspected);
        river(
            &mut s,
            &["4p", "5p", "6p", "7s", "1p", "2p", "3p", "1s", "2s", "3s"],
        );
        assert!(!high(&s, &[])); // late, but table floor is only 55.06
        let mut events: Vec<MjaiEvent> = Vec::new();
        for (i, d) in s.players[2].river.iter().enumerate() {
            if i == 7 {
                events.push(
                    serde_json::from_value(
                        json!({"type":"pon","actor":2,"target":1,"pai":"P","consumed":["P","P"]}),
                    )
                    .unwrap(),
                );
            }
            events.push(
                serde_json::from_value(
                    json!({"type":"dahai","actor":2,"pai":d.tile,"tsumogiri":false}),
                )
                .unwrap(),
            );
        }
        assert!((tenpai_reference(&s, &s.players[2], &events) - 77.62).abs() < 1e-6);
        assert!(high(&s, &events));
        events.pop(); // incomplete replay must not invent progress
        assert!(!high(&s, &events));
    }
    #[test]
    fn conflicting_calls_and_ankan_or_only_honors_do_not_infer_a_suit() {
        let mut s = sample();
        s.players[2].melds[0].tiles = vec!["1p".into(), "2p".into(), "3p".into()];
        assert!(assess(&s, &[]).is_empty());
        let mut s = sample();
        s.players[2].melds.push(serde_json::from_value(json!({"kind":"ankan","tiles":["9p","9p","9p","9p"],"from_who":-1,"called_tile":null})).unwrap());
        assert!(assess(&s, &[]).is_empty());
        let mut s = sample();
        s.players[2].melds = vec![s.players[2].melds[2].clone(); 3];
        assert!(assess(&s, &[]).is_empty());
    }
    #[test]
    fn recent_target_tedashi_demotes_but_old_discard_does_not_rule_out_flush() {
        let mut s = sample();
        river(&mut s, &["8m", "1p", "2p", "3p", "1s", "2s", "3s"]);
        assert!(high(&s, &[]));
        river(&mut s, &["7m", "8m", "1p", "2p", "1s", "2s"]);
        assert_eq!(assess(&s, &[])[0].level, Level::Watch);
        // Two target-suit tsumogiri are weaker contradictory evidence.
        s.players[2].river[0].tedashi = false;
        s.players[2].river[1].tedashi = false;
        assert!(high(&s, &[]));
    }
    #[test]
    fn risk_correction_keeps_safe_zero_and_other_suits_nonzero_and_overrides_weight_only() {
        let s = sample();
        let threats = assess(&s, &[]);
        let mut risk = [10.0; 34];
        risk[8] = 0.0; // a true safe 9m must stay safe
        let rate = adjust(&s, Some(&threats[0]), 68.2, 3000.0, &mut risk);
        assert_eq!(rate, 100.0);
        assert!(risk[4] > 10.0);
        assert!(risk[31] > 10.0); // live honor, including honitsu waits
        assert!(risk[9] > 0.0 && risk[9] < 10.0);
        assert_eq!(risk[8], 0.0);
        assert!(!s.players[2].riichi_declared);
        let mut normal = [10.0; 34];
        assert_eq!(adjust(&s, None, 68.2, 3000.0, &mut normal), 68.2);
        assert_eq!(normal, [10.0; 34]);
    }
    #[test]
    fn exposed_dora_counts_red_and_normal_bonus_but_c_excludes_ankan() {
        let mut s = sample();
        s.dora_markers = vec!["4m".into()];
        s.players[2].melds[1].tiles[1] = "5mr".into();
        assert_eq!(visible_open_dora(&s, &s.players[2]), 2);
        s.players[2].melds[1].kind = MeldKind::Ankan;
        assert_eq!(visible_open_dora(&s, &s.players[2]), 0);
        assert_eq!(visible_dora(&s, &s.players[2]), 2);
    }
}
