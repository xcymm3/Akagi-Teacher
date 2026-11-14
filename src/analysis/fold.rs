//! Sticky, decision-bound defensive control. Policy ranking is never edited.
use super::{
    coach::{analyze_candidates, CoachRequest},
    snapshot_adapter::to_player_info,
    tile::Tile34,
};
use crate::{
    game_state::snapshot::{GameStateSnapshot, MeldKind},
    schema::MjaiEvent,
};
use riichienv_core::{
    action::{Action, ActionType},
    parser::tid_to_mjai,
};
use serde::Serialize;

#[derive(Debug, Default, Clone)]
pub struct FoldState {
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FoldDecision {
    pub active: bool,
    pub reason: String,
    pub action: MjaiEvent,
    pub fallback: bool,
    pub risk: Option<f64>,
}

impl FoldState {
    pub fn active(&self) -> bool {
        self.reason.is_some()
    }
    pub fn reset(&mut self) {
        self.reason = None;
    }
    pub fn observe(&mut self, snapshot: &GameStateSnapshot) {
        if self.active() || snapshot.is_done {
            return;
        }
        self.reason = trigger(snapshot);
    }
    pub async fn decide(
        &self,
        snapshot: &GameStateSnapshot,
        events: &[MjaiEvent],
        legal: &[MjaiEvent],
    ) -> Option<FoldDecision> {
        let reason = self.reason.clone()?;
        // A legal win always takes priority over folding, irrespective of logits.
        if let Some(action) = legal.iter().find(|a| matches!(a, MjaiEvent::Hora { .. })) {
            return Some(FoldDecision {
                active: true,
                reason,
                action: action.clone(),
                fallback: false,
                risk: None,
            });
        }
        if !legal.iter().any(|a| matches!(a, MjaiEvent::Dahai { .. })) {
            return Some(FoldDecision {
                active: true,
                reason,
                action: MjaiEvent::None,
                fallback: false,
                risk: None,
            });
        }
        let helper = tokio::time::timeout(
            std::time::Duration::from_millis(750),
            super::coach::defence_risks(snapshot, events),
        )
        .await;
        let scores = helper
            .ok()
            .and_then(Result::ok)
            .and_then(|v| scores_from_go(&v, snapshot));
        let fallback = scores.is_none();
        let scores = scores.unwrap_or_else(|| fallback_scores(snapshot));
        let choice = choose_discard(snapshot, legal, &scores);
        let (action, risk) = choice
            .map(|(a, r)| (a, Some(r)))
            .unwrap_or((MjaiEvent::None, None));
        Some(FoldDecision {
            active: true,
            reason,
            action,
            fallback: fallback || risk.is_none(),
            risk,
        })
    }
}

fn trigger(s: &GameStateSnapshot) -> Option<String> {
    if s.is_done {
        return None;
    }
    let seat = s.our_seat?;
    let me = s.players.get(seat as usize)?;
    if me.riichi_declared || me.riichi_stage {
        return None;
    }
    let shanten = analyze_candidates(CoachRequest {
        snapshot: s.clone(),
        actions: vec![],
        events: vec![],
    })
    .ok()?
    .best_shanten;
    let riichi = s
        .players
        .iter()
        .filter(|p| p.seat != seat && p.riichi_declared)
        .count();
    if riichi >= 2 && shanten >= 1 {
        return Some(format!("B：至少两家立直，进入时{shanten}向听"));
    }
    if riichi >= 1 && shanten >= 2 {
        return Some(format!("A：对手立直，进入时{shanten}向听"));
    }
    if shanten >= 2 {
        for p in &s.players {
            if p.seat == seat {
                continue;
            }
            let open: Vec<_> = p
                .melds
                .iter()
                .filter(|m| m.kind != MeldKind::Ankan)
                .collect();
            if open.len() < 3 {
                continue;
            }
            let mut dora = 0;
            for t in open.iter().flat_map(|m| &m.tiles) {
                if t.ends_with('r') {
                    dora += 1;
                }
                for marker in &s.dora_markers {
                    if let (Some(t), Some(m)) = (Tile34::from_mjai(t), Tile34::from_mjai(marker)) {
                        let next = if s.num_players == 3 && m.idx() == 0 {
                            Tile34(8)
                        } else {
                            m.dora_next()
                        };
                        if t == next {
                            dora += 1;
                        }
                    }
                }
            }
            if dora >= 2 {
                return Some(format!("C：三组明副露、宝牌至少2枚；进入时{shanten}向听"));
            }
        }
    }
    None
}

/// This list is derived from the full engine legal set, never from the HUD top 3.
pub fn defensive_actions(
    legal: Vec<Action>,
    seat: u8,
    drawn: Option<u8>,
    discarder: Option<u8>,
) -> Vec<MjaiEvent> {
    legal
        .into_iter()
        .filter_map(|a| match a.action_type {
            ActionType::Discard => a.tile.map(|t| MjaiEvent::Dahai {
                actor: seat,
                pai: tid_to_mjai(t),
                tsumogiri: drawn == Some(t),
            }),
            ActionType::Ron => Some(MjaiEvent::Hora {
                actor: seat,
                target: discarder.unwrap_or(seat),
                deltas: None,
                ura_markers: None,
            }),
            ActionType::Tsumo => Some(MjaiEvent::Hora {
                actor: seat,
                target: seat,
                deltas: None,
                ura_markers: None,
            }),
            ActionType::Pass => Some(MjaiEvent::None),
            _ => None,
        })
        .collect()
}

fn scores_from_go(v: &serde_json::Value, s: &GameStateSnapshot) -> Option<[f64; 34]> {
    let opponents = v.get("opponents")?.as_array()?;
    if opponents.len() != s.num_players as usize - 1 {
        return None;
    }
    let mut seen = vec![false; s.num_players as usize];
    let mut scores = [0.0; 34];
    for op in opponents {
        let seat = op.get("seat")?.as_u64()? as usize;
        if seat >= seen.len() || Some(seat as u8) == s.our_seat || seen[seat] {
            return None;
        }
        seen[seat] = true;
        let rate = op.get("tenpai")?.as_f64()?;
        if !(0.0..=100.0).contains(&rate) {
            return None;
        }
        let risk = op.get("risk")?.as_array()?;
        if risk.len() != 34 {
            return None;
        }
        for (i, r) in risk.iter().enumerate() {
            let r = r.as_f64()?;
            if !r.is_finite() || r < 0.0 {
                return None;
            }
            scores[i] += r * rate / 100.0;
        }
    }
    Some(scores)
}

fn fallback_scores(s: &GameStateSnapshot) -> [f64; 34] {
    let mut scores = [f64::INFINITY; 34];
    if let Some(seat) = s.our_seat {
        if let Ok(mut info) = to_player_info(s, seat) {
            info.left_tiles = Some(super::coach::unseen(s, seat));
            scores = [0.0; 34];
            for op in &info.opponents {
                let r = super::risk::for_opponent(&info, op);
                for (score, risk) in scores.iter_mut().zip(r.risk) {
                    *score += risk * r.tenpai_rate / 100.0;
                }
            }
        }
    }
    scores
}

fn choose_discard(
    s: &GameStateSnapshot,
    legal: &[MjaiEvent],
    scores: &[f64; 34],
) -> Option<(MjaiEvent, f64)> {
    let mut best: Option<(MjaiEvent, f64)> = None;
    let me = s.players.get(s.our_seat? as usize)?;
    for action in legal {
        let MjaiEvent::Dahai { pai, .. } = action else {
            continue;
        };
        if !me.tehai.contains(pai) {
            continue;
        }
        let Some(tile) = Tile34::from_mjai(pai) else {
            continue;
        };
        let score = scores[tile.idx() as usize];
        if !score.is_finite() {
            continue;
        }
        if best.as_ref().is_none_or(|(_, old)| score < *old) {
            best = Some((action.clone(), score));
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot() -> GameStateSnapshot {
        let mut v: serde_json::Value =
            serde_json::from_str(include_str!("../../coach-go/fixture.json")).unwrap();
        let s = &mut v["snapshot"];
        for (k, v) in [
            ("kyoku", json!(1)),
            ("honba", json!(0)),
            ("kyotaku", json!(0)),
            ("current_player", json!(0)),
            ("turn_count", json!(4)),
            ("is_done", json!(false)),
        ] {
            s[k] = v;
        }
        for p in s["players"].as_array_mut().unwrap() {
            for (k, v) in [
                ("score", json!(25000)),
                ("riichi_stage", json!(false)),
                ("double_riichi", json!(false)),
                ("riichi_declaration_index", json!(null)),
                ("kita_tiles", json!([])),
                ("drawn_tile", json!(null)),
            ] {
                p[k] = v;
            }
        }
        let mut s: GameStateSnapshot = serde_json::from_value(s.clone()).unwrap();
        s.players[0].tehai = [
            "2m", "5m", "8m", "2p", "5p", "8p", "2s", "5s", "8s", "E", "S", "W", "N", "P",
        ]
        .map(String::from)
        .to_vec();
        s
    }
    fn discard(pai: &str) -> MjaiEvent {
        MjaiEvent::Dahai {
            actor: 0,
            pai: pai.into(),
            tsumogiri: false,
        }
    }
    #[test]
    fn a_triggers_but_does_not_fold_own_riichi_or_finished_round() {
        let mut s = snapshot();
        s.players[2].riichi_declared = true;
        assert!(trigger(&s).unwrap().starts_with("A"));
        s.players[0].riichi_declared = true;
        assert!(trigger(&s).is_none());
        s.players[0].riichi_declared = false;
        s.is_done = true;
        assert!(trigger(&s).is_none());
    }
    #[test]
    fn b_requires_two_riichi_for_one_shanten() {
        let mut s = snapshot();
        s.players[0].tehai = [
            "1m", "2m", "3m", "1p", "2p", "3p", "1s", "2s", "3s", "4s", "5s", "E", "F",
        ]
        .map(String::from)
        .to_vec();
        s.players[1].riichi_declared = true;
        assert!(trigger(&s).is_none());
        s.players[2].riichi_declared = true;
        assert!(trigger(&s).unwrap().starts_with("B"));
    }
    #[test]
    fn c_counts_red_dora_but_excludes_closed_kans() {
        let mut s = snapshot();
        s.dora_markers = vec!["1s".into()];
        s.players[1].melds = [
            vec!["5mr", "5m", "5m"],
            vec!["5pr", "5p", "5p"],
            vec!["7s", "7s", "7s"],
        ]
        .iter()
        .map(|ts| {
            serde_json::from_value(
                json!({"kind":"pon","tiles":ts,"from_who":2,"called_tile":ts[2]}),
            )
            .unwrap()
        })
        .collect();
        assert!(trigger(&s).unwrap().starts_with("C"));
        s.players[1].melds[0].tiles[0] = "5m".into();
        assert!(trigger(&s).is_none());
        s.players[1].melds[0].tiles[0] = "5mr".into();
        s.players[1].melds[2].kind = MeldKind::Ankan;
        assert!(trigger(&s).is_none());
    }
    #[test]
    fn fold_is_sticky_until_reset_even_when_threat_or_shanten_changes() {
        let mut s = snapshot();
        s.players[1].riichi_declared = true;
        let mut mode = FoldState::default();
        mode.observe(&s);
        let reason = mode.reason.clone();
        s.players[1].riichi_declared = false;
        s.is_done = true;
        mode.observe(&s);
        assert_eq!(mode.reason, reason);
        mode.reset();
        assert!(!mode.active());
    }
    #[test]
    fn selects_fourth_legal_discard_not_the_model_top_three() {
        let s = snapshot();
        let legal = [discard("2m"), discard("5m"), discard("8m"), discard("2p")];
        let mut risk = [10.0; 34];
        risk[10] = 0.0;
        let (a, r) = choose_discard(&s, &legal, &risk).unwrap();
        assert!(matches!(a,MjaiEvent::Dahai{ref pai,..} if pai=="2p"));
        assert_eq!(r, 0.0);
    }
    #[tokio::test]
    async fn calls_declined_and_legal_win_accepted_even_during_fold() {
        let mode = FoldState {
            reason: Some("test".into()),
        };
        let s = snapshot();
        let r = mode.decide(&s, &[], &[MjaiEvent::None]).await.unwrap();
        assert!(matches!(r.action, MjaiEvent::None));
        let win = MjaiEvent::Hora {
            actor: 0,
            target: 1,
            deltas: None,
            ura_markers: None,
        };
        let r = mode.decide(&s, &[], &[MjaiEvent::None, win]).await.unwrap();
        assert!(matches!(r.action, MjaiEvent::Hora { .. }));
    }
    #[tokio::test]
    async fn go_risk_only_returns_full_matrix_without_hand_search() {
        let s = snapshot();
        let v = super::super::coach::defence_risks(&s, &[]).await.unwrap();
        assert!(v["candidates"].as_array().unwrap().is_empty());
        assert!(scores_from_go(&v, &s).is_some());
        assert!(scores_from_go(&json!({"opponents":[]}), &s).is_none());
    }
    #[test]
    fn fallback_keeps_defensive_selection_and_correct_unseen_counts() {
        let mut s = snapshot();
        s.players[1].riichi_declared = true;
        s.players[1].river =
            vec![
                serde_json::from_value(json!({"tile":"2p","tedashi":true,"is_riichi":true}))
                    .unwrap(),
            ];
        let scores = fallback_scores(&s);
        let (a, r) = choose_discard(&s, &[discard("5m"), discard("2p")], &scores).unwrap();
        assert!(matches!(a,MjaiEvent::Dahai{ref pai,..} if pai=="2p"));
        assert_eq!(r, 0.0);
    }
}
