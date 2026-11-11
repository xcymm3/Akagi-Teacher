//! End-to-end numeric parity: the candle loader must reproduce the PyTorch
//! (folded) reference logits for a deterministic input. The reference JSON is
//! produced by `train/parity_check.py` next to the shipped weights.
#![cfg(feature = "infer")]

use std::fs;
use std::path::Path;

use native_bot::model::Model;

fn floats(v: &serde_json::Value) -> Vec<f32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap() as f32)
        .collect()
}

fn argmax(v: &[f32]) -> usize {
    v.iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .unwrap()
        .0
}

fn check(model_file: &str, parity_file: &str, num_players: u8) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("weights");
    let bytes = fs::read(dir.join(model_file)).expect("weights present");
    let model = Model::from_safetensors(bytes, num_players).expect("load model");

    let json: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join(parity_file)).expect("parity json")).unwrap();
    check_case(&model, &json, model_file);
    if let Some(cases) = json["cases"].as_array() {
        for case in cases {
            check_case(&model, case, model_file);
        }
    }
}

fn check_case(model: &Model, case: &serde_json::Value, model_file: &str) {
    let input = floats(&case["input"]);
    let reference = floats(&case["logits"]);

    let got = model.forward_logits(&input).expect("forward");
    assert_eq!(got.len(), reference.len(), "logit length mismatch");

    let max_diff = got
        .iter()
        .zip(&reference)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    let mut legal_logits = got.clone();
    if let Some(mask) = case["mask"].as_array() {
        assert_eq!(mask.len(), got.len());
        for (logit, allowed) in legal_logits.iter_mut().zip(mask) {
            if allowed.as_u64() == Some(0) {
                *logit = f32::NEG_INFINITY;
            }
        }
    }
    assert_eq!(
        argmax(&legal_logits),
        case["argmax"].as_u64().unwrap() as usize,
        "candle argmax differs from PyTorch"
    );
    assert!(
        // Deep folded networks can produce very large logits for the synthetic
        // stress input. Use mixed FP32 tolerances, while retaining a strict
        // absolute tolerance for ordinary replay observations.
        got.iter()
            .zip(&reference)
            .all(|(a, b)| (a - b).abs() < 2e-3 + 1e-5 * b.abs()),
        "candle vs PyTorch logit diff too large: {max_diff}"
    );
    eprintln!("{model_file}: candle/PyTorch max|diff| = {max_diff:.2e}, argmax matches");
}

#[test]
fn parity_4p() {
    check("akagi4p.safetensors", "parity_4p.json", 4);
}

#[test]
fn parity_3p() {
    check("akagi3p.safetensors", "parity_3p.json", 3);
}
