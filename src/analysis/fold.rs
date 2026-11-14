//! Sticky, decision-bound defensive control. Policy ranking is never edited.
use super::{
    coach::{analyze_candidates, CoachRequest},
    flush::{self, FlushThreat, Level},
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
    pub flush_threats: Vec<FlushThreat>,
}

impl FoldState {
    pub fn active(&self) -> bool {
        self.reason.is_some()
    }
    pub fn reset(&mut self) {
        self.reason = None;
    }
    pub fn observe(&mut self, snapshot: &GameStateSnapshot, events: &[MjaiEvent]) {
        if self.active() || snapshot.is_done {
            return;
        }
        self.reason = trigger(snapshot, events);
    }
    pub async fn decide(
        &self,
        snapshot: &GameStateSnapshot,
        events: &[MjaiEvent],
        legal: &[MjaiEvent],
    ) -> Option<FoldDecision> {
        let reason = self.reason.clone()?;
        let threats = flush::assess(snapshot, events);
        // A legal win always takes priority over folding, irrespective of logits.
        if let Some(action) = legal.iter().find(|a| matches!(a, MjaiEvent::Hora { .. })) {
            return Some(FoldDecision {
                active: true,
                reason,
                action: action.clone(),
                fallback: false,
                risk: None,
                flush_threats: threats,
            });
        }
        if !legal.iter().any(|a| matches!(a, MjaiEvent::Dahai { .. })) {
            return Some(FoldDecision {
                active: true,
                reason,
                action: MjaiEvent::None,
                fallback: false,
                risk: None,
                flush_threats: threats,
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
            .and_then(|v| scores_from_go(&v, snapshot, &threats));
        let fallback = scores.is_none();
        let scores = scores.unwrap_or_else(|| fallback_scores(snapshot, events, &threats));
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
            flush_threats: threats,
        })
    }
}

fn trigger(s: &GameStateSnapshot, events: &[MjaiEvent]) -> Option<String> {
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
    let threats = flush::assess(s, events);
    let high: Vec<_> = threats.iter().filter(|t| t.level == Level::High).collect();
    let riichi = s
        .players
        .iter()
        .filter(|p| p.seat != seat && p.riichi_declared)
        .count();
    let threat_count = riichi + high.len(); // assess excludes actual riichi seats
    let detail = high
        .iter()
        .map(|t| {
            let relative = (t.seat + s.num_players - seat) % s.num_players;
            let name = match relative {
                1 => "下家",
                2 if s.num_players == 4 => "对家",
                _ => "上家",
            };
            let suit = match t.suit.as_str() {
                "m" => "万字",
                "p" => "筒子",
                _ => "条子",
            };
            format!("{name}疑似{suit}染手、接近听牌")
        })
        .collect::<Vec<_>>()
        .join("；");
    if threat_count >= 2 && shanten >= 1 {
        return Some(if high.is_empty() {
            format!("B：至少两家立直，进入时{shanten}向听")
        } else {
            format!("B：{detail}；共{threat_count}家立直级威胁，进入时{shanten}向听")
        });
    }
    if threat_count >= 1 && shanten >= 2 {
        return Some(if high.is_empty() {
            format!("A：对手立直，进入时{shanten}向听")
        } else {
            format!("A：{detail}；进入时{shanten}向听")
        });
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
            if open.len() >= 2 && flush::visible_open_dora(s, p) >= 3 {
                return Some(format!(
                    "C：至少两组明副露、宝牌至少3枚；进入时{shanten}向听"
                ));
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

fn scores_from_go(
    v: &serde_json::Value,
    s: &GameStateSnapshot,
    threats: &[FlushThreat],
) -> Option<[f64; 34]> {
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
        let loss = op.get("loss")?.as_f64()?;
        if !loss.is_finite() || loss <= 0.0 {
            return None;
        }
        let mut per_tile = [0.0; 34];
        for (i, r) in risk.iter().enumerate() {
            let r = r.as_f64()?;
            if !r.is_finite() || r < 0.0 {
                return None;
            }
            per_tile[i] = r;
        }
        let rate = flush::adjust(
            s,
            threats.iter().find(|t| t.seat as usize == seat),
            rate,
            loss,
            &mut per_tile,
        );
        for (score, risk) in scores.iter_mut().zip(per_tile) {
            *score += risk * rate / 100.0;
        }
    }
    Some(scores)
}

fn fallback_scores(
    s: &GameStateSnapshot,
    events: &[MjaiEvent],
    threats: &[FlushThreat],
) -> [f64; 34] {
    let Some(seat) = s.our_seat else {
        return [f64::INFINITY; 34];
    };
    let left = super::coach::unseen(s, seat);
    let dora: Vec<_> = s
        .dora_markers
        .iter()
        .filter_map(|raw| Tile34::from_mjai(raw))
        .map(|t| {
            if s.num_players == 3 && t.idx() == 0 {
                Tile34(8)
            } else {
                t.dora_next()
            }
        })
        .collect();
    let bakaze = Tile34::from_mjai(&s.bakaze).unwrap_or(Tile34(27));
    let mut scores = [0.0; 34];
    for p in s.players.iter().filter(|p| p.seat != seat) {
        // Own river remains safe after a hand change. Do not invent persistent
        // passed-tile safety for a non-riichi flush opponent in this fallback.
        let mut safe = [false; 34];
        for d in &p.river {
            if let Some(t) = Tile34::from_mjai(&d.tile) {
                safe[t.idx() as usize] = true;
            }
        }
        let wind = Tile34(27 + (p.seat + s.num_players - s.oya) % s.num_players);
        let mut risk =
            super::risk::base::risk_tiles(p.river.len(), &safe, &left, &dora, bakaze, wind);
        let early: Vec<_> = p
            .river
            .iter()
            .take(5)
            .filter_map(|d| Tile34::from_mjai(&d.tile))
            .collect();
        super::risk::base::fix_with_early_outside(&mut risk, &early);
        let loss = flush::ordinary_loss(s, p);
        super::risk::base::fix_with_point(&mut risk, loss);
        let rate = flush::adjust(
            s,
            threats.iter().find(|t| t.seat == p.seat),
            flush::tenpai_reference(s, p, events),
            loss,
            &mut risk,
        );
        for (score, risk) in scores.iter_mut().zip(risk) {
            *score += risk * rate / 100.0;
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
        assert!(trigger(&s, &[]).unwrap().starts_with("A"));
        s.players[0].riichi_declared = true;
        assert!(trigger(&s, &[]).is_none());
        s.players[0].riichi_declared = false;
        s.is_done = true;
        assert!(trigger(&s, &[]).is_none());
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
        assert!(trigger(&s, &[]).is_none());
        s.players[2].riichi_declared = true;
        assert!(trigger(&s, &[]).unwrap().starts_with("B"));
    }
    #[test]
    fn c_requires_two_open_melds_and_three_exposed_dora() {
        let mut s = snapshot();
        s.dora_markers = vec!["2p".into()];
        s.players[1].melds = [
            ("pon", vec!["5mr", "5m", "5m"]),
            ("chi", vec!["3p", "4p", "5pr"]),
        ]
        .iter()
        .map(|(kind, ts)| {
            serde_json::from_value(json!({"kind":kind,"tiles":ts,"from_who":2,"called_tile":ts[2]}))
                .unwrap()
        })
        .collect();
        // Two red tiles + one ordinary dora = exactly three.
        assert!(trigger(&s, &[]).unwrap().starts_with("C"));
        s.dora_markers.clear();
        assert!(trigger(&s, &[]).is_none()); // two bonuses is insufficient
        s.dora_markers = vec!["4m".into()];
        s.players[1].melds[0].kind = MeldKind::Ankan;
        assert!(trigger(&s, &[]).is_none()); // ankan neither a group nor C's dora
        s.players[1].melds.push(
            serde_json::from_value(json!({
                "kind":"pon","tiles":["7s","7s","7s"],"from_who":2,"called_tile":"7s"
            }))
            .unwrap(),
        );
        assert!(trigger(&s, &[]).is_none()); // two open groups, but only one open red
    }
    #[test]
    fn fold_is_sticky_until_reset_even_when_threat_or_shanten_changes() {
        let mut s = snapshot();
        s.players[1].riichi_declared = true;
        let mut mode = FoldState::default();
        mode.observe(&s, &[]);
        let reason = mode.reason.clone();
        s.players[1].riichi_declared = false;
        s.is_done = true;
        mode.observe(&s, &[]);
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
        assert!(scores_from_go(&v, &s, &[]).is_some());
        assert!(scores_from_go(&json!({"opponents":[]}), &s, &[]).is_none());
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
        let scores = fallback_scores(&s, &[], &[]);
        let (a, r) = choose_discard(&s, &[discard("5m"), discard("2p")], &scores).unwrap();
        assert!(matches!(a,MjaiEvent::Dahai{ref pai,..} if pai=="2p"));
        assert_eq!(r, 0.0);
    }

    #[test]
    fn high_flush_counts_as_one_threat_and_combines_with_real_riichi() {
        let mut s = crate::analysis::flush::tests::sample();
        assert!(trigger(&s, &[]).unwrap().contains("对家疑似万字染手"));
        s.players[0].tehai = [
            "1m", "2m", "3m", "1p", "2p", "3p", "1s", "2s", "3s", "4s", "5s", "E", "F",
        ]
        .map(String::from)
        .to_vec();
        assert!(trigger(&s, &[]).is_none()); // one threat does not fold 1-shanten
        s.players[1].riichi_declared = true;
        assert!(trigger(&s, &[]).unwrap().starts_with("B"));
        s.players[1].riichi_declared = false;
        s.players[2].riichi_declared = true;
        assert!(trigger(&s, &[]).is_none()); // the same seat is never counted twice
        s.players[0].riichi_declared = true;
        assert!(trigger(&s, &[]).is_none());
    }

    #[tokio::test]
    async fn flush_go_and_fallback_shift_risk_and_remain_dynamic_after_sticky_entry() {
        let mut s = crate::analysis::flush::tests::sample();
        let threats = flush::assess(&s, &[]);
        let raw = super::super::coach::defence_risks(&s, &[]).await.unwrap();
        let base = scores_from_go(&raw, &s, &[]).unwrap();
        let adjusted = scores_from_go(&raw, &s, &threats).unwrap();
        let fallback_base = fallback_scores(&s, &[], &[]);
        let fallback_flush = fallback_scores(&s, &[], &threats);
        assert!(adjusted[7] > base[7]); // 8m has not passed: target suit increases
        assert!(fallback_flush[7] > fallback_base[7]);
        // Different suit, not genbutsu, and not eliminated by walls: lower
        // conditional risk even though the high threat's readiness is now 100.
        assert!(adjusted[16] < base[16]); // 8p
        assert!(fallback_flush[16] < fallback_base[16]);
        let mut mode = FoldState::default();
        mode.observe(&s, &[]);
        assert!(mode.active());
        let result = mode
            .decide(&s, &[], &[discard("8m"), discard("8p")])
            .await
            .unwrap();
        assert_eq!(result.flush_threats[0].level, Level::High);
        assert!(matches!(result.action,MjaiEvent::Dahai{ref pai,..} if pai=="8p"));
        // A new incompatible call removes the flush adjustment, while our
        // already-entered fold mode remains active until next kyoku.
        s.players[2].melds[0].tiles = vec!["4p".into(), "5p".into(), "6p".into()];
        mode.observe(&s, &[]);
        assert!(mode.active());
        let result = mode
            .decide(&s, &[], &[discard("8m"), discard("8p")])
            .await
            .unwrap();
        assert!(result.flush_threats.is_empty());
        mode.reset();
        assert!(!mode.active());
    }

    #[tokio::test]
    async fn treating_flush_as_ready_does_not_extend_temporary_safety() {
        let mut s = crate::analysis::flush::tests::sample();
        let events: Vec<MjaiEvent> = serde_json::from_value(json!([
            {"type":"dahai","actor":1,"pai":"8m","tsumogiri":false},
            {"type":"tsumo","actor":0,"pai":"5p"}
        ]))
        .unwrap();
        let raw = super::super::coach::defence_risks(&s, &events)
            .await
            .unwrap();
        let threats = flush::assess(&s, &events);
        let scores = scores_from_go(&raw, &s, &threats).unwrap();
        assert_eq!(scores[7], 0.0); // passed, no opponent has drawn since
        let mut events = events;
        events.push(serde_json::from_value(json!({"type":"tsumo","actor":2,"pai":"?"})).unwrap());
        s.phase = crate::game_state::snapshot::Phase::WaitResponse;
        let raw = super::super::coach::defence_risks(&s, &events)
            .await
            .unwrap();
        let scores = scores_from_go(&raw, &s, &threats).unwrap();
        assert!(scores[7] > 0.0); // non-riichi safety expires, despite 100% policy weight
        assert!(!s.players[2].riichi_declared);
    }
}
