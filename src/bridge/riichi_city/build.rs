//! Riichi City outbound (client → server) frame builder.
//!
//! Gameplay actions ride `"req_game_action"` with the same numeric action
//! codes the server broadcasts back. Every shape below is verified against
//! the client's own senders (the game logic ships as plain-text Lua:
//! `ReqOutCard`/`ReqGameOpt` in `lua_models_game` build the frames, the
//! offer construction in `lua_procestates_game_components` fills in
//! `card`/`group_cards`/positions, `EMjActionType` in
//! `lua_procestates_game` names the codes), cross-checked with recorded
//! uplink frames from live play.
//!
//! Wire positions (`move_cards_pos`) are 1-based slots in the client's
//! tile *rack*: the sorted concealed hand with a freshly drawn tile
//! appended LAST. The engine's tehai merges the drawn tile in sort order
//! instead, so [`Rack`] reconstructs the client's view before any
//! position is computed.

use crate::schema::MjaiEvent;
use serde_json::{json, Value};

use super::packet::WPacket;

const CMD_GAME_ACTION: &str = "req_game_action";

/// The WPacket binary command every request rides (0 = heartbeat, 1 =
/// auth).
const BIN_CMD_REQUEST: u16 = 6;

/// Action codes shared with the inbound `cmd_game_action_brc`. Verified
/// against the client's `EMjActionType` enum and uplink recordings: 1
/// pass, 2/3/4 chi variants (claimed tile low/middle/high in the run),
/// 5 pon, 6 daiminkan, 7 ron, 8 ankan, 9 kakan, 10 tsumo, 11 dahai,
/// 12 kyuushu (nine terminals, `ActionEndGame` — offered as
/// `is_nine_cards`), 13 kita.
mod action {
    pub const PASS: i64 = 1;
    pub const RON: i64 = 7;
    pub const TSUMO: i64 = 10;
    pub const DAHAI: i64 = 11;
    pub const NINE_CARDS: i64 = 12;
    pub const KITA: i64 = 13;
    pub const PON: i64 = 5;
    pub const DAIMINKAN: i64 = 6;
    pub const ANKAN: i64 = 8;
    pub const KAKAN: i64 = 9;
}

/// The chi variant code: where the claimed tile sits in the run — 2 = low
/// end, 3 = middle, 4 = high end. A wrong (or unoffered) variant gets a
/// `code 0` ack but is never applied; the call window just runs out.
fn chi_action_code(claimed: u32, consumed: &[u32; 2]) -> Option<i64> {
    let rank = |c: u32| c & 0x0f;
    let mut run = [rank(claimed), rank(consumed[0]), rank(consumed[1])];
    run.sort_unstable();
    if run[0] == rank(claimed) {
        Some(2)
    } else if run[1] == rank(claimed) {
        Some(3)
    } else {
        Some(4)
    }
}

/// The client's rack view of our hand: concealed tiles in engine (sorted)
/// order with the currently held draw re-appended last, the way the
/// client displays and indexes them. All wire positions are 1-based
/// slots in this rack.
struct Rack {
    tiles: Vec<String>,
    /// The last slot is a freshly drawn tile (wall or rinshan).
    drawn_last: bool,
}

impl Rack {
    /// `hand` is the engine tehai (drawn tile merged in sort order);
    /// `drawn` is the tile currently held from the wall, if any.
    fn build(hand: Option<&[String]>, drawn: Option<&str>) -> Option<Rack> {
        let hand = hand?;
        if hand.is_empty() {
            return None;
        }
        let mut tiles = hand.to_vec();
        let drawn_last = drawn
            .and_then(|d| tiles.iter().position(|t| t == d))
            .map(|i| {
                let t = tiles.remove(i);
                tiles.push(t);
            })
            .is_some();
        Some(Rack { tiles, drawn_last })
    }

    fn len(&self) -> usize {
        self.tiles.len()
    }

    /// 1-based positions of `tiles`, collected by scanning the rack in
    /// order with each slot used at most once — exactly how the client's
    /// offer builders (`GetCardIdx`/`GetPengIdx`/`GetChiIdx`) walk the
    /// rack. Also returns the matched rack tiles in that same scan order,
    /// which is the order the client lists `group_cards` in. `None` when
    /// any tile is missing from the rack.
    fn positions<'a>(&'a self, tiles: &[String]) -> Option<(Vec<u32>, Vec<&'a str>)> {
        let mut want: Vec<&String> = tiles.iter().collect();
        let mut pos = Vec::with_capacity(tiles.len());
        let mut matched = Vec::with_capacity(tiles.len());
        for (i, t) in self.tiles.iter().enumerate() {
            if let Some(w) = want.iter().position(|w| *w == t) {
                want.remove(w);
                pos.push(i as u32 + 1);
                matched.push(t.as_str());
                if want.is_empty() {
                    break;
                }
            }
        }
        if want.is_empty() {
            Some((pos, matched))
        } else {
            None
        }
    }

    /// 1-based rack slot of the first tile of `pai`'s kind (red and plain
    /// fives match each other) — the client's masked `RealFlag` scan used
    /// by the kakan and kita offers.
    fn first_of_kind(&self, pai: &str) -> Option<u32> {
        let kind = mjai_to_card(pai)? & 0xff;
        self.tiles
            .iter()
            .position(|t| mjai_to_card(t).is_some_and(|c| c & 0xff == kind))
            .map(|i| i as u32 + 1)
    }
}

/// A claim request: `{action, card}` plus the consumed tiles and their
/// rack slots, mirroring the client's offer construction (`group_cards`
/// and `move_cards_pos` both listed in rack-scan order — for a pon this
/// is also how the red-five choice reaches the server). Without a rack
/// the consumed tiles go out in the bot's order and the positions are
/// omitted; the client always sends both, but the server derives the
/// meld from `group_cards`.
fn call_data(action: i64, card: u32, rack: Option<&Rack>, consumed: &[String]) -> Option<Value> {
    let mut d = json!({ "action": action, "card": card });
    match rack.and_then(|r| r.positions(consumed)) {
        Some((pos, matched)) => {
            d["group_cards"] = json!(cards(matched)?);
            d["move_cards_pos"] = json!(pos);
        }
        None => d["group_cards"] = json!(cards(consumed)?),
    }
    Some(d)
}

/// mjai tile string → Riichi City card code (inverse of `consts::card_to_mjai`).
/// Returns `None` for `"?"` and anything malformed — encoding a hidden tile
/// means the caller's state is wrong, and the right move is to skip the action.
pub fn mjai_to_card(pai: &str) -> Option<u32> {
    let code = match pai {
        "?" => return None,
        "1p" => 0x01,
        "2p" => 0x02,
        "3p" => 0x03,
        "4p" => 0x04,
        "5p" => 0x05,
        "6p" => 0x06,
        "7p" => 0x07,
        "8p" => 0x08,
        "9p" => 0x09,
        "1s" => 0x11,
        "2s" => 0x12,
        "3s" => 0x13,
        "4s" => 0x14,
        "5s" => 0x15,
        "6s" => 0x16,
        "7s" => 0x17,
        "8s" => 0x18,
        "9s" => 0x19,
        "1m" => 0x21,
        "2m" => 0x22,
        "3m" => 0x23,
        "4m" => 0x24,
        "5m" => 0x25,
        "6m" => 0x26,
        "7m" => 0x27,
        "8m" => 0x28,
        "9m" => 0x29,
        "E" => 0x31,
        "S" => 0x41,
        "W" => 0x51,
        "N" => 0x61,
        "P" => 0x71,
        "F" => 0x81,
        "C" => 0x91,
        "5pr" => 0x105,
        "5sr" => 0x115,
        "5mr" => 0x125,
        _ => return None,
    };
    Some(code)
}

fn cards(pais: impl IntoIterator<Item = impl AsRef<str>>) -> Option<Vec<u32>> {
    pais.into_iter().map(|p| mjai_to_card(p.as_ref())).collect()
}

/// Encode one bot decision as the client frame that performs it, without
/// table context (see [`encode_action_with`] for the context-aware form).
pub fn encode_action(ev: &MjaiEvent) -> Option<Vec<u8>> {
    encode_action_with(ev, None, None, None)
}

/// [`encode_action`] plus the table state some actions need: the tile
/// currently held from the wall (a tsumo's `card` is the winning tile,
/// and the rack racks it last), the most recent discard (a ron's `card`
/// is the claimed tile), and our tehai (discards and calls carry rack
/// positions, calls also `group_cards`). The autoplay planner supplies
/// all three from its `ActionContext` snapshot.
pub fn encode_action_with(
    ev: &MjaiEvent,
    drawn: Option<&str>,
    last_discard: Option<&str>,
    hand: Option<&[String]>,
) -> Option<Vec<u8>> {
    let rack = Rack::build(hand, drawn);
    let rack = rack.as_ref();
    let data: Value = match ev {
        MjaiEvent::Dahai { pai, tsumogiri, .. } => dahai_data(pai, *tsumogiri, false, rack)?,
        MjaiEvent::Reach { pai: Some(pai), .. } => dahai_data(pai, false, true, rack)?,
        // Chi and pon: the claim buttons send the variant code, the
        // claimed tile, and the consumed pair with its rack slots
        // (`GetChiIdx`/`GetPengIdx` — which offer a second button when a
        // red five makes the pair ambiguous, so `group_cards` is the
        // choice, not decoration).
        MjaiEvent::Chi { pai, consumed, .. } => {
            let card = mjai_to_card(pai)?;
            let group = cards(consumed)?;
            call_data(
                chi_action_code(card, &[group[0], group[1]])?,
                card,
                rack,
                consumed,
            )?
        }
        MjaiEvent::Pon { pai, consumed, .. } => {
            call_data(action::PON, mjai_to_card(pai)?, rack, consumed)?
        }
        // Daiminkan: `card` names the claimed discard, `group_cards` the
        // three matching tiles from our hand, `move_cards_pos` their
        // rack slots.
        MjaiEvent::Daiminkan { pai, consumed, .. } => {
            call_data(action::DAIMINKAN, mjai_to_card(pai)?, rack, consumed)?
        }
        // Ankan (offer builder): the four copies are looked up in rack
        // order; `card` is the first, `group_cards` the remaining three
        // ("服务器只需要三张" — the client's own comment), and
        // `move_cards_pos` all four slots.
        MjaiEvent::Ankan { consumed, .. } => match rack.and_then(|r| r.positions(consumed)) {
            Some((pos, matched)) => {
                let group = cards(matched)?;
                json!({
                    "action": action::ANKAN,
                    "card": group.first().copied()?,
                    "group_cards": &group[1..],
                    "move_cards_pos": pos,
                })
            }
            None => {
                let group = cards(consumed)?;
                json!({
                    "action": action::ANKAN,
                    "card": group.first().copied()?,
                    "group_cards": &group[1..],
                })
            }
        },
        // Kakan (`ActionBuGang`): the promoted tile plus the rack slot of
        // the first tile of its kind (the client scans by masked flag);
        // `ReqGameOpt` drops `group_cards` for this action.
        MjaiEvent::Kakan { pai, .. } => {
            let mut d = json!({ "action": action::KAKAN, "card": mjai_to_card(pai)? });
            if let Some(p) = rack.and_then(|r| r.first_of_kind(pai)) {
                d["move_cards_pos"] = json!([p]);
            }
            d
        }
        // Kita (`ActionPullNorth`): the north tile plus its rack slot.
        MjaiEvent::Kita { pai, .. } => {
            let pai = pai.as_deref().unwrap_or("N");
            let mut d = json!({ "action": action::KITA, "card": mjai_to_card(pai)? });
            if let Some(p) = rack.and_then(|r| r.first_of_kind(pai)) {
                d["move_cards_pos"] = json!([p]);
            }
            d
        }
        // Tsumo names its winning tile (`{"action":10,"card":6}` for a 6p
        // self-draw win — recorded). A ron mirrors it with the claimed
        // discard, per the client's claim-button construction.
        MjaiEvent::Hora { target, actor, .. } => {
            let mut d =
                json!({ "action": if target == actor { action::TSUMO } else { action::RON } });
            if let Some(pai) = if target == actor { drawn } else { last_discard } {
                d["card"] = json!(mjai_to_card(pai)?);
            }
            d
        }
        // Verified: declining a call window is a bare `{"action":1}`.
        MjaiEvent::None => json!({ "action": action::PASS }),
        // Kyuushu (nine terminals): the offer builder adds a bare
        // `{action = ActionEndGame}` for `is_nine_cards` and the button
        // click sends it unchanged through `ReqGameOpt` — nil fields
        // omitted, no confirm dialog. Only the bot's declaration form
        // (`deltas: None`, how `BotAction::Kyushu` maps) is encodable: a
        // Ryukyoku carrying deltas is an exhaustive draw observed on the
        // wire, never a decision we can send.
        MjaiEvent::Ryukyoku { deltas: None } => json!({ "action": action::NINE_CARDS }),
        _ => return None,
    };
    Some(action_frame(&data))
}

/// A discard request. Riichi is the same request with `is_li_zhi: true`
/// (verified: the recorded riichi discard carries exactly these fields).
///
/// `move_cards_pos` is `[index, toIndex]`, display metadata the server
/// relays so other clients can animate. `index` is the tile's 1-based
/// rack slot; the client sends the LAST slot for the held draw and clamps
/// a would-be last-slot tedashi to the slot before it
/// (`CheckOutCardIndex`), so `index == rack len` on a drawn turn always
/// means tsumogiri — our own inbound decoder relies on that, which makes
/// this formula load-bearing, not just cosmetic. `toIndex` is where the
/// drawn tile slides after a tedashi; it depends on the player's
/// tile-sort setting (`GetMoveIndexByOutCard`'s `sortMap`), so we send
/// the client's own fallback `#privateList - 1` — also its real value
/// for every tsumogiri. Without a rack: the recorded placeholder shapes.
fn dahai_data(pai: &str, tsumogiri: bool, riichi: bool, rack: Option<&Rack>) -> Option<Value> {
    let pos: Value = match rack {
        Some(rack) => {
            let len = rack.len() as u32;
            let to = (len - 1).max(1);
            // Rack slots that are not the held draw — a tedashi can only
            // come from these.
            let hand_slots = rack.len() - rack.drawn_last as usize;
            let from = if tsumogiri {
                len
            } else {
                match rack.tiles[..hand_slots].iter().position(|t| t == pai) {
                    Some(i) => i as u32 + 1,
                    // Only the held draw matches: a riichi that discards
                    // the drawn tile lands here (mjai `reach` carries no
                    // tsumogiri flag) — the client names the drawn slot.
                    None if rack.drawn_last && rack.tiles[hand_slots] == pai => len,
                    // Tile not in the rack (state mismatch): the client's
                    // clamp value keeps the shape plausible.
                    None => to,
                }
            };
            json!([from, to])
        }
        // No rack: the recorded placeholder shapes.
        None => json!([if tsumogiri { 14 } else { 13 }, 13]),
    };
    Some(json!({
        "action": action::DAHAI,
        "card": mjai_to_card(pai)?,
        "is_li_zhi": riichi,
        // Double-riichi flag. TODO: set when the bot's reach is declared on
        // its first uninterrupted turn (junme <= 1 with no calls).
        "is_xuan_gao_ting": false,
        "li_zhi_operate": 0,
        "move_cards_pos": pos,
    }))
}

fn action_frame(data: &Value) -> Vec<u8> {
    WPacket::encode_request(
        BIN_CMD_REQUEST,
        &json!({ "cmd": CMD_GAME_ACTION, "data": data }),
    )
}

/// The round-advance press ("OK" on the scoring screen — the second OK; the
/// first is client-local only). Verified: one bare `req_user_prepare` per
/// round end advances to the next round (`rsp_user_prepare code 0` +
/// `cmd_user_prepare` broadcast; a duplicate gets `code 2`, harmlessly).
pub fn user_prepare() -> Vec<u8> {
    WPacket::encode_request(BIN_CMD_REQUEST, &json!({ "cmd": "req_user_prepare" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every frame we build must survive the inbound parser unchanged —
    /// whatever the real uplink shapes turn out to be, this invariant is
    /// how captures get compared against these templates.
    #[test]
    fn frames_round_trip_through_the_parser() {
        let cases = vec![
            MjaiEvent::Dahai {
                actor: 0,
                pai: "3m".into(),
                tsumogiri: true,
            },
            MjaiEvent::Dahai {
                actor: 0,
                pai: "5sr".into(),
                tsumogiri: false,
            },
            MjaiEvent::Reach {
                actor: 0,
                pai: Some("1p".into()),
            },
            MjaiEvent::Chi {
                actor: 0,
                target: 3,
                pai: "2s".into(),
                consumed: ["1s".into(), "3s".into()],
            },
            MjaiEvent::Pon {
                actor: 0,
                target: 1,
                pai: "N".into(),
                consumed: ["N".into(), "N".into()],
            },
            MjaiEvent::Daiminkan {
                actor: 0,
                target: 2,
                pai: "E".into(),
                consumed: ["E".into(), "E".into(), "E".into()],
            },
            MjaiEvent::Ankan {
                actor: 0,
                consumed: ["5mr".into(), "5m".into(), "5m".into(), "5m".into()],
            },
            MjaiEvent::Kakan {
                actor: 0,
                pai: "5pr".into(),
                consumed: ["5p".into(), "5p".into(), "5p".into()],
            },
            MjaiEvent::Kita {
                actor: 0,
                pai: Some("N".into()),
            },
            MjaiEvent::Hora {
                actor: 0,
                target: 0,
                deltas: None,
                ura_markers: None,
            },
            MjaiEvent::Hora {
                actor: 0,
                target: 1,
                deltas: None,
                ura_markers: None,
            },
            MjaiEvent::None,
        ];
        for ev in cases {
            let frame = encode_action_with(&ev, Some("6p"), Some("7s"), None)
                .unwrap_or_else(|| panic!("no frame for {ev:?}"));
            let pkts = WPacket::parse_frame(&frame);
            assert_eq!(pkts.len(), 1, "one packet per frame for {ev:?}");
            assert_eq!(pkts[0].body["cmd"], CMD_GAME_ACTION);
        }
    }

    /// The chi variant code must say where the claimed tile sits in the run
    /// — a blanket wrong code gets acked but silently never applied.
    #[test]
    fn chi_variant_codes_match_the_offered_action_list() {
        // Claiming 6m keeping 7m8m → 6m is the low tile → 2 (verified manual).
        let low = MjaiEvent::Chi {
            actor: 0,
            target: 3,
            pai: "6m".into(),
            consumed: ["7m".into(), "8m".into()],
        };
        // Claiming 6m keeping 5m7m → middle → 3 (verified manual).
        let mid = MjaiEvent::Chi {
            actor: 0,
            target: 3,
            pai: "6m".into(),
            consumed: ["5m".into(), "7m".into()],
        };
        // Claiming 8p keeping 6p7p → high tile → 4.
        let high = MjaiEvent::Chi {
            actor: 0,
            target: 3,
            pai: "8p".into(),
            consumed: ["6p".into(), "7p".into()],
        };
        // Red five counts as its plain rank: claiming 3p keeping 4p5pr.
        let red = MjaiEvent::Chi {
            actor: 0,
            target: 3,
            pai: "3p".into(),
            consumed: ["4p".into(), "5pr".into()],
        };
        let code = |ev: &MjaiEvent| {
            WPacket::parse_frame(&encode_action(ev).unwrap())[0].body["data"]["action"].clone()
        };
        assert_eq!(code(&low), 2);
        assert_eq!(code(&mid), 3);
        assert_eq!(code(&high), 4);
        assert_eq!(code(&red), 2, "the incident case from the live game");

        // The full three-way case: claiming 5m holding 3m4m5m6m7m — all
        // three variants are offered and each pick maps to its own code.
        let pick = |a: &str, b: &str| MjaiEvent::Chi {
            actor: 0,
            target: 3,
            pai: "5m".into(),
            consumed: [a.into(), b.into()],
        };
        assert_eq!(code(&pick("3m", "4m")), 4, "3-4-5: claimed is high");
        assert_eq!(code(&pick("4m", "6m")), 3, "4-5-6: claimed is middle");
        assert_eq!(code(&pick("6m", "7m")), 2, "5-6-7: claimed is low");
    }

    /// Claims carry the consumed tiles (`group_cards`) and their 1-based
    /// rack slots (`move_cards_pos`), both in rack-scan order — the shape
    /// every `ReqGameOpt` button sends. Unresolvable slots omit only the
    /// position field; `group_cards` still expresses the meld.
    #[test]
    fn calls_carry_hand_positions_when_known() {
        let hand: Vec<String> = [
            "1m", "2m", "4p", "5pr", "6s", "7s", "E", "E", "E", "W", "N", "P", "F",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let daiminkan = MjaiEvent::Daiminkan {
            actor: 0,
            target: 1,
            pai: "E".into(),
            consumed: ["E".into(), "E".into(), "E".into()],
        };
        let pkt = &WPacket::parse_frame(
            &encode_action_with(&daiminkan, None, None, Some(&hand)).unwrap(),
        )[0];
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([7, 8, 9]));
        assert_eq!(pkt.body["data"]["group_cards"], json!([0x31, 0x31, 0x31]));

        let pon = MjaiEvent::Pon {
            actor: 0,
            target: 1,
            pai: "E".into(),
            consumed: ["E".into(), "E".into()],
        };
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&pon, None, None, Some(&hand)).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 5);
        assert_eq!(pkt.body["data"]["card"], 0x31);
        assert_eq!(pkt.body["data"]["group_cards"], json!([0x31, 0x31]));
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([7, 8]));

        // The red-five choice travels in `group_cards`: the client offers
        // one button per candidate pair, so the pair the bot chose must
        // go out.
        let chi = MjaiEvent::Chi {
            actor: 0,
            target: 1,
            pai: "3p".into(),
            consumed: ["4p".into(), "5pr".into()],
        };
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&chi, None, None, Some(&hand)).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 2, "claimed 3p is the low end");
        assert_eq!(pkt.body["data"]["group_cards"], json!([0x04, 0x105]));
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([3, 4]));

        // Tiles not in the tracked hand: positions are omitted, the meld
        // itself still goes out.
        let unknown: Vec<String> = vec!["9s".to_string(); 13];
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&chi, None, None, Some(&unknown)).unwrap())
                [0];
        assert!(pkt.body["data"].get("move_cards_pos").is_none());
        assert_eq!(pkt.body["data"]["group_cards"], json!([0x04, 0x105]));
    }

    /// Ankan carries three `group_cards` (the client's own comment:
    /// "服务器只需要三张") with the rack slots of all four — the freshly
    /// drawn fourth copy racks LAST, not at its sorted position — and the
    /// promoted-tile kakan carries only the tile and its slot.
    #[test]
    fn kan_shapes_match_the_client_sender() {
        let hand: Vec<String> = [
            "1m", "2m", "5m", "5mr", "5m", "5m", "6s", "7s", "E", "S", "W", "N", "P",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let ankan = MjaiEvent::Ankan {
            actor: 0,
            consumed: ["5mr".into(), "5m".into(), "5m".into(), "5m".into()],
        };
        // No draw tracked: the four copies sit at rack slots 3-6, and
        // `card`/`group_cards` list them in rack-scan order.
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&ankan, None, None, Some(&hand)).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 8);
        assert_eq!(pkt.body["data"]["card"], 0x25);
        assert_eq!(pkt.body["data"]["group_cards"], json!([0x125, 0x25, 0x25]));
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([3, 4, 5, 6]));

        // With the fourth copy freshly drawn, its slot is the rack's last
        // (the engine merges it into sort order; the client racks it
        // apart on the right).
        let pkt = &WPacket::parse_frame(
            &encode_action_with(&ankan, Some("5m"), None, Some(&hand)).unwrap(),
        )[0];
        assert_eq!(pkt.body["data"]["card"], 0x125);
        assert_eq!(pkt.body["data"]["group_cards"], json!([0x25, 0x25, 0x25]));
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([3, 4, 5, 13]));

        let kakan = MjaiEvent::Kakan {
            actor: 0,
            pai: "5p".into(),
            consumed: ["5p".into(), "5p".into(), "5p".into()],
        };
        let hand2: Vec<String> = vec!["5p".to_string(); 14];
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&kakan, None, None, Some(&hand2)).unwrap())
                [0];
        assert_eq!(pkt.body["data"]["action"], 9);
        assert_eq!(pkt.body["data"]["card"], 0x05);
        assert!(pkt.body["data"].get("group_cards").is_none());
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([1]));
    }

    /// Kita sends the north tile plus its rack slot (the client's
    /// `ActionPullNorth` offer carries `idxs = {idx}`); with no tracked
    /// hand the slot is omitted.
    #[test]
    fn kita_names_its_rack_slot() {
        let kita = MjaiEvent::Kita {
            actor: 0,
            pai: Some("N".into()),
        };
        let hand: Vec<String> = ["1m", "2m", "3m", "N", "P"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&kita, None, None, Some(&hand)).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 13);
        assert_eq!(pkt.body["data"]["card"], 0x61);
        assert_eq!(pkt.body["data"]["move_cards_pos"], json!([4]));

        let pkt = &WPacket::parse_frame(&encode_action(&kita).unwrap())[0];
        assert_eq!(pkt.body["data"].as_object().unwrap().len(), 2);
        assert_eq!(pkt.body["data"]["card"], 0x61);
    }

    /// A ron names the claimed discard, mirroring the tsumo's winning
    /// tile — the client's claim buttons send `{action, card}`.
    #[test]
    fn ron_names_the_claimed_discard() {
        let ron = MjaiEvent::Hora {
            actor: 0,
            target: 2,
            deltas: None,
            ura_markers: None,
        };
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&ron, None, Some("7s"), None).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 7);
        assert_eq!(pkt.body["data"]["card"], 0x17);
        assert_eq!(pkt.body["data"].as_object().unwrap().len(), 2);
    }

    /// Kyuushu (nine terminals) is a bare `{"action":12}` — the offer
    /// builder's `{action = ActionEndGame}` for `is_nine_cards`, sent
    /// unchanged by the button click. Regression for a live timeout
    /// (2026-08-23): the bot declared on a 9-terminal first draw and the
    /// unencodable action left the window open until the server
    /// auto-discarded ~27s later.
    #[test]
    fn kyuushu_is_a_bare_twelve() {
        let pkt =
            &WPacket::parse_frame(&encode_action(&MjaiEvent::Ryukyoku { deltas: None }).unwrap())
                [0];
        assert_eq!(pkt.body["cmd"], CMD_GAME_ACTION);
        assert_eq!(pkt.body["data"]["action"], 12);
        assert_eq!(
            pkt.body["data"].as_object().unwrap().len(),
            1,
            "no card, no positions — the client sends the code alone"
        );
    }

    /// A Ryukyoku carrying deltas is an exhaustive draw observed on the
    /// wire, not a decision — it must never encode.
    #[test]
    fn an_observed_draw_is_not_an_action() {
        assert!(encode_action(&MjaiEvent::Ryukyoku {
            deltas: Some(vec![1000, -1000, 1000, -1000]),
        })
        .is_none());
    }

    /// Verbatim from the recording: a 6p self-draw win went out as
    /// `{"action":10,"card":6}`; pass was a bare `{"action":1}`.
    #[test]
    fn tsumo_and_pass_match_the_recorded_shapes() {
        let tsumo = MjaiEvent::Hora {
            actor: 3,
            target: 3,
            deltas: None,
            ura_markers: None,
        };
        let pkt =
            &WPacket::parse_frame(&encode_action_with(&tsumo, Some("6p"), None, None).unwrap())[0];
        // Regression (2026-08-20 live test): frames built with binary cmd 0
        // are heartbeats — the server silently dropped every injected
        // action. Gameplay requests ride binary cmd 6.
        assert_eq!(pkt.cmd, 6, "gameplay requests must ride binary cmd 6");
        assert_eq!(pkt.body["data"]["action"], 10);
        assert_eq!(pkt.body["data"]["card"], 6);

        let pkt = &WPacket::parse_frame(&encode_action(&MjaiEvent::None).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 1);
        assert_eq!(
            pkt.body["data"].as_object().unwrap().len(),
            1,
            "pass is bare"
        );
    }

    /// Verbatim from the recording: the riichi discard carried the full
    /// field set with `is_li_zhi: true`, and a tsumogiri used
    /// `move_cards_pos: [14,13]`.
    #[test]
    fn discard_shapes_match_the_recording() {
        let riichi = MjaiEvent::Reach {
            actor: 3,
            pai: Some("7m".into()),
        };
        let pkt = &WPacket::parse_frame(&encode_action(&riichi).unwrap())[0];
        assert_eq!(pkt.body["data"]["action"], 11);
        assert_eq!(pkt.body["data"]["is_li_zhi"], true);
        assert_eq!(pkt.body["data"]["is_xuan_gao_ting"], false);
        assert_eq!(pkt.body["data"]["li_zhi_operate"], 0);

        let tsumogiri = MjaiEvent::Dahai {
            actor: 3,
            pai: "N".into(),
            tsumogiri: true,
        };
        let pkt = &WPacket::parse_frame(&encode_action(&tsumogiri).unwrap())[0];
        assert_eq!(pkt.body["data"]["move_cards_pos"][0], 14);
        assert_eq!(pkt.body["data"]["move_cards_pos"][1], 13);
        assert_eq!(pkt.body["data"]["is_li_zhi"], false);
    }

    /// With the hand tracked, `move_cards_pos` follows the client's
    /// formula: the tile's 1-based rack slot with the held draw racked
    /// last, and the client's `#privateList - 1` fallback as `toIndex`.
    /// `index == rack len` must mean tsumogiri and nothing else — our own
    /// inbound decoder infers the flag from it.
    #[test]
    fn discard_positions_follow_the_client_formula() {
        // Engine tehai after drawing the 3m: merged into sort order.
        let hand: Vec<String> = [
            "1m", "2m", "3m", "4p", "5p", "6s", "7s", "8s", "9s", "E", "S", "W", "N", "C",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let dahai = |pai: &str, tsumogiri: bool| MjaiEvent::Dahai {
            actor: 0,
            pai: pai.into(),
            tsumogiri,
        };
        let pos = |ev: &MjaiEvent, hand: &[String]| {
            WPacket::parse_frame(&encode_action_with(ev, Some("3m"), None, Some(hand)).unwrap())[0]
                .body["data"]["move_cards_pos"]
                .clone()
        };
        // Tedashi of the 4p: rack slot 3 (the drawn 3m no longer sits
        // between 2m and 4p — it racks last).
        assert_eq!(pos(&dahai("4p", false), &hand), json!([3, 13]));
        // Tsumogiri names the last slot.
        assert_eq!(pos(&dahai("3m", true), &hand), json!([14, 13]));
        // Tedashi of the hand's highest tile: slot 13, NOT 14 — the
        // engine sorts the drawn 3m into the middle, but the rack keeps
        // it last, so the lone C stays below the tsumogiri sentinel.
        assert_eq!(pos(&dahai("C", false), &hand), json!([13, 13]));

        // Post-meld turn: ten concealed tiles plus the draw rack 11
        // slots, so tsumogiri names 11 (the inbound decoder keys on
        // rack size per seat, not on a constant 14).
        let melded: Vec<String> = [
            "1m", "2m", "3m", "4p", "5p", "6s", "7s", "8s", "9s", "E", "S",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(pos(&dahai("3m", true), &melded), json!([11, 10]));

        // A riichi that discards the drawn tile (its only copy) names the
        // drawn slot — mjai `reach` has no tsumogiri flag to say so.
        let riichi = MjaiEvent::Reach {
            actor: 0,
            pai: Some("3m".into()),
        };
        let no_other_3m: Vec<String> = [
            "1m", "2m", "3m", "4p", "5p", "6s", "7s", "8s", "9s", "E", "S", "W", "N", "C",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(pos(&riichi, &no_other_3m), json!([14, 13]));
    }

    /// The round-advance press must be a bare req_user_prepare on binary
    /// cmd 6, matching what the client sends after each scoring screen.
    #[test]
    fn user_prepare_matches_the_recorded_shape() {
        let pkt = &WPacket::parse_frame(&user_prepare())[0];
        assert_eq!(pkt.cmd, 6);
        assert_eq!(pkt.body["cmd"], "req_user_prepare");
        assert!(pkt.body.get("data").is_none(), "no data payload");
    }

    #[test]
    fn hidden_tile_is_refused() {
        let ev = MjaiEvent::Dahai {
            actor: 0,
            pai: "?".into(),
            tsumogiri: true,
        };
        assert!(encode_action(&ev).is_none());
    }

    #[test]
    fn non_actions_have_no_frame() {
        assert!(encode_action(&MjaiEvent::EndGame {
            reason: Default::default(),
            final_scores: None,
            final_ranks: None,
            rank_points: Vec::new(),
        })
        .is_none());
        // A reach without its declaring tile cannot be sent — same contract
        // as the Majsoul/Tenhou planners.
        assert!(encode_action(&MjaiEvent::Reach {
            actor: 0,
            pai: None
        })
        .is_none());
    }

    /// The inverse table must be exact: every code the inbound table maps to
    /// a known tile maps back to that code.
    #[test]
    fn tile_inverse_is_total_and_exact() {
        for code in 0u32..=0x125 {
            let m = super::super::consts::card_to_mjai(code);
            if m == "?" {
                continue;
            }
            assert_eq!(mjai_to_card(&m), Some(code), "round trip failed for {m}");
        }
    }
}
