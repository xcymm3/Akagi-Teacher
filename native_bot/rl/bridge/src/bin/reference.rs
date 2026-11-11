//! Independent full-prefix replay oracle; does not call the Python bridge.
use std::io::{self, BufRead, Write};
use native_bot::{action_codec, adapt, chankan, mjai_compat};
use riichienv_core::{action::Action, replay::MjaiEvent, rule::GameRule, state::GameState};
use serde_json::{json, Value};

fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let seat = input["seat"].as_u64().unwrap() as u8;
        let mut state = GameState::new(0, true, None, 0, GameRule::default_tenhou());
        for raw in input["events"].as_array().unwrap() {
            let event = mjai_compat::parse_line(raw.as_str().unwrap(), 4).unwrap();
            let opponent_kan = match &event {
                MjaiEvent::Kakan { actor, pai } if *actor != seat as usize => Some((*actor as u8, pai.clone())),
                _ => None,
            };
            state.apply_mjai_event(event);
            if let Some((actor, pai)) = opponent_kan {
                chankan::open_on_kakan(&mut state, actor, &pai, seat);
            }
        }
        let (features, replay_legal) = adapt::obs_and_legal_4p(&mut state, seat);
        let quantized: Vec<u8> = features.iter().map(|v| ((v.clamp(0.0, 4.0) / 4.0) * 255.0).round() as u8).collect();
        let legal: Vec<Action> = serde_json::from_value(input["actions"].clone()).unwrap();
        let logits: Vec<f32> = serde_json::from_value(input["logits"].clone()).unwrap();
        let ranked: Vec<_> = action_codec::rank_by_logits(&legal, &logits, 4, 82)
            .into_iter().map(|(a, prob)| (legal.iter().position(|original| original == &a).unwrap(), prob)).collect();
        println!("{}", json!({"features": features, "quantized": quantized,
            "mask": action_codec::legal_mask(&legal, 4), "ranked": ranked,
            "replay_mask": action_codec::legal_mask(&replay_legal, 4)}));
        io::stdout().flush().unwrap();
    }
}
