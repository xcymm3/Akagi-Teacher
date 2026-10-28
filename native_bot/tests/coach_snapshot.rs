//! A read-only coaching snapshot must not change any subsequent policy output.
use native_bot::defaults;
use serde_json::json;

#[test]
fn inspecting_four_and_three_player_states_preserves_actions_and_logits() {
    for n in [3, 4] {
        let mut baseline = defaults::engine(n, 0).unwrap();
        let mut coached = defaults::engine(n, 0).unwrap();
        let hand = vec![
            "1p", "2p", "3p", "4p", "5p", "6p", "1s", "2s", "3s", "7s", "8s", "E", "E",
        ];
        let mut hands = vec![vec!["?"; 13]; n as usize];
        hands[0] = hand;
        let events = [
            json!({"type":"start_game", "names":vec!["player"; n as usize]}),
            json!({"type":"start_kyoku", "bakaze":"E", "dora_marker":"9p", "kyoku":1,
                "honba":0, "kyotaku":0, "oya":0, "scores":vec![35000; n as usize], "tehais":hands}),
            json!({"type":"tsumo", "actor":0, "pai":"9s"}),
        ];
        for ev in events {
            assert!(baseline.feed_line(&ev.to_string()));
            assert!(coached.feed_line(&ev.to_string()));
        }
        for _ in 0..3 {
            let before = baseline.decide().unwrap().unwrap();
            let _ = coached.inspect_state(|s| s.players.len(), |s| s.players.len());
            let after = coached.decide().unwrap().unwrap();
            assert_eq!(before.action, after.action);
            assert_eq!(before.candidates, after.candidates);
            assert_eq!(before.logits, after.logits);
            assert_eq!(before.forced, after.forced);
        }
    }
}
