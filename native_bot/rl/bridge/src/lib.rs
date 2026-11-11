//! Thin Python bindings to the SAME observation/event/action code as Akagi.
//! The old replay engine supplies features, never authority over new legal actions.
use native_bot::{action_codec, adapt, chankan, mjai_compat};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use riichienv_core::action::Action;
use riichienv_core::replay::MjaiEvent;
use riichienv_core::rule::GameRule;
use riichienv_core::state::GameState;

fn error(message: impl ToString) -> PyErr {
    PyValueError::new_err(message.to_string())
}

#[pyclass]
struct ReplayEncoder {
    state: GameState,
    seat: u8,
    ready: bool,
}

#[pymethods]
impl ReplayEncoder {
    #[new]
    fn new(seat: u8) -> PyResult<Self> {
        if seat >= 4 {
            return Err(error("Only four-player seats 0..3 are supported"));
        }
        Ok(Self {
            state: GameState::new(0, true, None, 0, GameRule::default_tenhou()),
            seat,
            ready: false,
        })
    }

    fn feed(&mut self, line: &str) -> PyResult<()> {
        let event = mjai_compat::parse_line(line, 4)
            .ok_or_else(|| error("Malformed or unsupported MJAI event"))?;
        match &event {
            MjaiEvent::StartGame { .. } => self.ready = false,
            MjaiEvent::StartKyoku { scores, tehais, oya, .. } => {
                if scores.len() != 4 || tehais.len() != 4 || *oya >= 4 {
                    return Err(error("Invalid four-player start_kyoku"));
                }
                self.ready = true;
            }
            MjaiEvent::Tsumo { actor, .. }
            | MjaiEvent::Dahai { actor, .. }
            | MjaiEvent::Kakan { actor, .. }
            | MjaiEvent::Reach { actor }
            | MjaiEvent::ReachAccepted { actor }
            | MjaiEvent::Hora { actor, .. } => {
                if *actor >= 4 {
                    return Err(error("Invalid actor"));
                }
            }
            MjaiEvent::Chi { actor, consumed, .. }
            | MjaiEvent::Pon { actor, consumed, .. } => {
                if *actor >= 4 || consumed.len() != 2 {
                    return Err(error("Invalid chi/pon"));
                }
            }
            MjaiEvent::Kan { actor, consumed, .. } => {
                if *actor >= 4 || consumed.len() != 3 {
                    return Err(error("Invalid daiminkan"));
                }
            }
            MjaiEvent::Ankan { actor, consumed } => {
                if *actor >= 4 || consumed.len() != 4 {
                    return Err(error("Invalid ankan"));
                }
            }
            MjaiEvent::Kita { .. } => return Err(error("Kita is not a four-player event")),
            _ => {}
        }
        if !self.ready && !matches!(event, MjaiEvent::StartGame { .. }) {
            return Err(error("start_kyoku required before replay events"));
        }
        // Exactly the Engine::feed compatibility hook, including chankan.
        let kakan = match &event {
            MjaiEvent::Kakan { actor, pai } if *actor as u8 != self.seat => {
                Some((*actor as u8, pai.clone()))
            }
            _ => None,
        };
        let end_game = matches!(event, MjaiEvent::EndGame);
        self.state.apply_mjai_event(event);
        if end_game {
            self.state.is_done = true;
        }
        if let Some((actor, pai)) = kakan {
            chankan::open_on_kakan(&mut self.state, actor, &pai, self.seat);
        }
        Ok(())
    }

    fn encode(&mut self) -> PyResult<Vec<f32>> {
        if !self.ready || self.state.is_done {
            return Err(error("No active hand to encode"));
        }
        Ok(adapt::obs_and_legal_4p(&mut self.state, self.seat).0)
    }

    // Diagnostic only. Production must use RiichiEnv 0.4.11's legal actions.
    fn replay_legal_mask(&mut self) -> PyResult<Vec<u8>> {
        if !self.ready {
            return Err(error("No hand"));
        }
        let (_, legal) = adapt::obs_and_legal_4p(&mut self.state, self.seat);
        Ok(action_codec::legal_mask(&legal, 4))
    }
}

fn parse_actions(json: &str) -> PyResult<Vec<Action>> {
    let actions: Vec<Action> = serde_json::from_str(json).map_err(error)?;
    if actions.is_empty() {
        return Err(error("No legal actions"));
    }
    for action in &actions {
        if action.actor.is_some_and(|p| p >= 4)
            || action.tile.is_some_and(|t| t >= 136)
            || action.consume_tiles.iter().any(|t| *t >= 136)
            || action_codec::action_index(action, 4).is_none()
        {
            return Err(error("Invalid four-player action"));
        }
    }
    Ok(actions)
}

#[pyfunction]
fn action_table(json: &str) -> PyResult<(Vec<u8>, Vec<(usize, usize)>)> {
    let actions = parse_actions(json)?;
    let mask = action_codec::legal_mask(&actions, 4);
    let mut representatives = Vec::new();
    for (chosen, _) in action_codec::rank_by_logits(&actions, &[0.0; 82], 4, 82) {
        let index = actions.iter().position(|a| a == &chosen).unwrap();
        representatives.push((action_codec::action_index(&chosen, 4).unwrap(), index));
    }
    Ok((mask, representatives))
}

#[pyfunction]
fn rank_actions(json: &str, logits: Vec<f32>) -> PyResult<Vec<(usize, f32)>> {
    if logits.len() != 82 || logits.iter().any(|x| !x.is_finite()) {
        return Err(error("Expected 82 finite logits"));
    }
    let actions = parse_actions(json)?;
    Ok(action_codec::rank_by_logits(&actions, &logits, 4, 82)
        .into_iter()
        .map(|(a, p)| (actions.iter().position(|original| original == &a).unwrap(), p))
        .collect())
}

#[pyfunction]
fn quantize(features: Vec<f32>) -> PyResult<Vec<u8>> {
    if features.len() != 39 * 34 || features.iter().any(|x| !x.is_finite()) {
        return Err(error("Expected finite 39 x 34 observations"));
    }
    // Identical to native_bot/src/bin/extract.rs::quantize (Rust round, not bankers').
    Ok(features.into_iter().map(|v| ((v.clamp(0.0, 4.0) / 4.0) * 255.0).round() as u8).collect())
}

#[pymodule]
fn _akagi_bridge(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<ReplayEncoder>()?;
    m.add_function(wrap_pyfunction!(action_table, m)?)?;
    m.add_function(wrap_pyfunction!(rank_actions, m)?)?;
    m.add_function(wrap_pyfunction!(quantize, m)?)?;
    m.add("FEATURE_CONTRACT", "akagi-mjai-0.4.8-raw-v1")?;
    Ok(())
}
