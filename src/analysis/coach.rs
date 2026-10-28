//! Optional, read-only evidence for the native bot's first three candidates.
//! Receives an immutable decision snapshot; never consults the live tracker.
//! This deliberately computes shanten/ukeire only, not a second policy or EV.

use super::{shanten, snapshot_adapter::to_player_info, tile::Tile34, waits};
use crate::game_state::snapshot::GameStateSnapshot;
use crate::schema::MjaiEvent;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct CoachRequest {
    pub snapshot: GameStateSnapshot,
    pub actions: Vec<MjaiEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CandidateFacts {
    pub action: MjaiEvent,
    pub shanten: Option<i8>,
    pub effective_tiles: Option<u32>,
    /// Genbutsu against these already-riichi seats ONLY, not universal safety.
    pub safe_against: Vec<u8>,
    pub isolated: bool,
    pub keeps_dora: bool,
    pub discards_dora: bool,
    /// Concentrated suit (0=m,1=p,2=s), a possible direction, not confirmed yaku.
    pub flush_suit: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoachFacts {
    pub seat: u8,
    pub num_players: u8,
    pub best_shanten: i8,
    pub riichi_seats: Vec<u8>,
    pub closed_hand: bool,
    pub candidates: Vec<CandidateFacts>,
}

/// Count unseen copies from public information, including our own river and
/// kita, without double-counting called discards. Unseen != live-wall copies.
fn unseen(snap: &GameStateSnapshot, seat: u8) -> [u8; 34] {
    let mut left = [4u8; 34];
    let mut remove = |s: &str| {
        if let Some(t) = Tile34::from_mjai(s) {
            let n = &mut left[t.idx() as usize];
            *n = n.saturating_sub(1);
        }
    };
    for p in &snap.players {
        if p.seat == seat {
            for t in &p.tehai {
                remove(t);
            }
        }
        for d in &p.river {
            if !d.called {
                remove(&d.tile);
            }
        }
        for m in &p.melds {
            for t in &m.tiles {
                remove(t);
            }
        }
        for t in &p.kita_tiles {
            remove(t);
        }
    }
    for t in &snap.dora_markers {
        remove(t);
    }
    if snap.num_players == 3 {
        left[1..8].fill(0);
    }
    left
}

pub fn analyze_candidates(request: CoachRequest) -> Result<CoachFacts, String> {
    let snap = request.snapshot;
    let seat = snap.our_seat.ok_or("missing decision seat")?;
    if !matches!(snap.num_players, 3 | 4)
        || snap.players.len() != snap.num_players as usize
        || seat >= snap.num_players
        || request.actions.len() > 3
        || snap
            .players
            .iter()
            .enumerate()
            .any(|(i, p)| p.seat as usize != i || p.tehai.len() > 14)
    {
        return Err("invalid coaching snapshot".into());
    }
    let me = &snap.players[seat as usize];
    let mut info = to_player_info(&snap, seat).map_err(|e| e.to_string())?;
    let size = info.hand_size();
    if !matches!(size, 1 | 2 | 4 | 5 | 7 | 8 | 10 | 11 | 13 | 14)
        || info.hand.iter().any(|&n| n > 4)
    {
        return Err("transient or invalid hand".into());
    }
    info.left_tiles = Some(unseen(&snap, seat));
    let is_discard = size % 3 == 2;
    let mut best_shanten = shanten(&info);
    if is_discard {
        best_shanten = (0..34)
            .filter(|&i| info.hand[i] > 0)
            .filter_map(|i| super::shanten::shanten_with_removed(&info, i as u8))
            .min()
            .ok_or("no discard")?;
    }
    let riichi_seats = snap
        .players
        .iter()
        .filter(|p| p.seat != seat && p.riichi_declared)
        .map(|p| p.seat)
        .collect();
    let dora: Vec<_> = info
        .dora_indicators
        .iter()
        .map(|d| {
            // Sanma removes 2m..8m, so the 1m indicator wraps directly to 9m.
            if snap.num_players == 3 && d.idx() == 0 {
                Tile34(8)
            } else {
                d.dora_next()
            }
        })
        .collect();
    let mut candidates = Vec::new();
    for action in request.actions {
        let mut facts = CandidateFacts {
            action: action.clone(),
            shanten: None,
            effective_tiles: None,
            safe_against: vec![],
            isolated: false,
            keeps_dora: false,
            discards_dora: false,
            flush_suit: None,
        };
        let discard = match &action {
            MjaiEvent::Dahai { pai, actor, .. } if *actor == seat => Some(pai),
            MjaiEvent::Reach {
                pai: Some(pai),
                actor,
            } if *actor == seat && !pai.is_empty() => Some(pai),
            _ => None,
        };
        if let Some(pai) = discard.filter(|_| is_discard) {
            let tile = Tile34::from_mjai(pai).ok_or("invalid candidate tile")?;
            let idx = tile.idx() as usize;
            // Missing/red-mismatched candidates get no invented numerical facts.
            if me.tehai.contains(pai) {
                let mut after = info.clone();
                after.hand[idx] -= 1;
                facts.shanten = Some(shanten(&after));
                facts.effective_tiles = Some(waits(&after).total_left());
                facts.safe_against = snap
                    .players
                    .iter()
                    .filter(|p| {
                        p.seat != seat
                            && p.riichi_declared
                            && p.river
                                .iter()
                                .any(|d| Tile34::from_mjai(&d.tile) == Some(tile))
                    })
                    .map(|p| p.seat)
                    .collect();
                facts.isolated = info.hand[idx] == 1
                    && (idx >= 27
                        || (idx.saturating_sub(2)..=(idx + 2).min(26))
                            .all(|j| j == idx || j / 9 != idx / 9 || info.hand[j] == 0));
                facts.discards_dora = pai.ends_with('r') || dora.contains(&tile);
                facts.keeps_dora = me.tehai.iter().enumerate().any(|(i, t)| {
                    let removed = me.tehai.iter().position(|s| s == pai);
                    Some(i) != removed
                        && (t.ends_with('r')
                            || Tile34::from_mjai(t).is_some_and(|t| dora.contains(&t)))
                });
                for suit in 0..3usize {
                    let count: u8 = after.hand[suit * 9..suit * 9 + 9].iter().sum();
                    let other: u8 = after.hand[..27]
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| i / 9 != suit)
                        .map(|(_, n)| *n)
                        .sum();
                    let compatible = after
                        .melds
                        .iter()
                        .flat_map(|m| &m.tiles)
                        .all(|t| t.is_honor() || t.idx() as usize / 9 == suit);
                    if count >= 8 && other <= 2 && compatible {
                        facts.flush_suit = Some(suit as u8);
                    }
                }
            }
        }
        candidates.push(facts);
    }
    Ok(CoachFacts {
        seat,
        num_players: snap.num_players,
        best_shanten,
        riichi_seats,
        closed_hand: info.melds.iter().all(|m| m.kind.is_concealed()),
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> GameStateSnapshot {
        let hand = [
            "1m", "2m", "3m", "1p", "2p", "3p", "1s", "2s", "3s", "4s", "5s", "6s", "E", "9p",
        ];
        let players: Vec<_> = (0..4).map(|seat| json!({
            "seat": seat, "tehai": if seat == 0 { hand.to_vec() } else { vec!["?"; 13] },
            "melds": [], "river": if seat == 2 { vec![json!({"tile":"4s", "tedashi":true, "is_riichi":true, "called":false})] } else { vec![] },
            "score":25000, "riichi_declared":seat==2, "riichi_stage":false,
            "double_riichi":false, "riichi_declaration_index":null, "kita_tiles":[], "drawn_tile":null
        })).collect();
        serde_json::from_value(json!({
            "bakaze":"E", "kyoku":1, "honba":0, "kyotaku":0, "oya":0,
            "current_player":0, "turn_count":8, "phase":"wait_act", "is_done":false,
            "num_players":4, "players":players, "dora_markers":["2m"], "our_seat":0
        }))
        .unwrap()
    }
    fn discard(pai: &str) -> MjaiEvent {
        serde_json::from_value(json!({"type":"dahai", "actor":0, "pai":pai, "tsumogiri":false}))
            .unwrap()
    }
    #[test]
    fn candidates_keep_order_and_snapshot_is_read_only() {
        let snap = snapshot();
        let before = serde_json::to_value(&snap).unwrap();
        let facts = analyze_candidates(CoachRequest {
            snapshot: snap.clone(),
            actions: vec![discard("9p"), discard("4s"), discard("E")],
        })
        .unwrap();
        assert_eq!(serde_json::to_value(&snap).unwrap(), before);
        assert_eq!(facts.best_shanten, 0);
        assert_eq!(facts.candidates[0].shanten, Some(0));
        assert!(facts.candidates[1].shanten.unwrap() > 0);
        assert_eq!(facts.candidates[1].safe_against, vec![2]);
        assert!(facts.candidates[0].safe_against.is_empty());
        assert!(facts.candidates[0].isolated);
        assert_eq!(
            serde_json::to_value(&facts.candidates[0].action).unwrap()["pai"],
            "9p"
        );
    }
    #[test]
    fn unseen_includes_own_river_and_does_not_return_discard_to_pool() {
        let mut snap = snapshot();
        snap.players[0]
            .river
            .push(crate::game_state::snapshot::DiscardEntry {
                tile: "E".into(),
                tedashi: true,
                is_riichi: false,
                called: false,
            });
        assert_eq!(unseen(&snap, 0)[27], 2); // hand E + own discarded E
        let facts = analyze_candidates(CoachRequest {
            snapshot: snap,
            actions: vec![discard("9p")],
        })
        .unwrap();
        assert_eq!(facts.candidates[0].effective_tiles, Some(2)); // waiting for E
    }
    #[test]
    fn red_five_and_plain_five_share_genbutsu_but_keep_value_distinction() {
        let mut snap = snapshot();
        snap.players[0].tehai[13] = "5pr".into();
        snap.players[2].river[0].tile = "5p".into();
        let facts = analyze_candidates(CoachRequest {
            snapshot: snap,
            actions: vec![discard("5pr")],
        })
        .unwrap();
        assert_eq!(facts.candidates[0].safe_against, vec![2]);
        assert!(facts.candidates[0].discards_dora);
    }
    #[test]
    fn unheld_tile_and_pass_get_no_invented_metrics() {
        let snap = snapshot();
        let facts = analyze_candidates(CoachRequest {
            snapshot: snap,
            actions: vec![discard("8m"), MjaiEvent::None],
        })
        .unwrap();
        assert!(facts
            .candidates
            .iter()
            .all(|c| c.shanten.is_none() && c.effective_tiles.is_none()));
    }
    #[test]
    fn sanma_has_no_middle_man_tiles_in_unseen_pool() {
        let mut snap = snapshot();
        snap.num_players = 3;
        snap.players.pop();
        assert_eq!(&unseen(&snap, 0)[1..8], &[0; 7]);
    }

    #[test]
    fn sanma_one_man_indicator_marks_nine_man_as_dora() {
        let mut snap = snapshot();
        snap.num_players = 3;
        snap.players.pop();
        snap.players[0].tehai[1] = "9m".into();
        snap.players[0].tehai[2] = "1m".into();
        snap.dora_markers = vec!["1m".into()];
        let facts = analyze_candidates(CoachRequest {
            snapshot: snap,
            actions: vec![discard("9m")],
        })
        .unwrap();
        assert!(facts.candidates[0].discards_dora);
    }
}
