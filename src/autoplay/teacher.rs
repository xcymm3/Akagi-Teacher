//! Arbitration changes execution only; the model's HUD ranking stays intact.
use crate::analysis::coach::{CoachFacts, CoachRequest};
use crate::bot::BotResponse;
use crate::schema::MjaiEvent;

pub fn request(resp: &BotResponse) -> Option<CoachRequest> {
    let meta = resp.meta.as_ref()?;
    let probability = meta.pointer("/show/items/0/prob")?.as_f64()?;
    if !probability.is_finite() || !(0.0..=0.6).contains(&probability) {
        return None;
    }
    let request: CoachRequest =
        serde_json::from_value(meta.pointer("/show/coach")?.clone()).ok()?;
    // Only native, decision-bound candidates. Never substitute a stale card.
    if serde_json::to_value(request.actions.first()?).ok()?
        != serde_json::to_value(&resp.action).ok()?
    {
        return None;
    }
    Some(request)
}

pub fn preferred(facts: &CoachFacts) -> Option<MjaiEvent> {
    let helper = facts.helper.as_ref()?;
    let index = usize::try_from(helper.get("preferred_index")?.as_i64()?).ok()?;
    // Match the frontend's unsupported-shape guard, including kokushi.
    for i in [0, index] {
        let candidate = facts.candidates.get(i)?;
        let metric = helper.get("candidates")?.get(i)?;
        let shanten = metric.get("shanten")?.as_i64()?;
        if candidate.shanten.is_some_and(|s| i64::from(s) != shanten) {
            return None;
        }
    }
    Some(facts.candidates.get(index)?.action.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(probability: f64) -> BotResponse {
        let mut fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../coach-go/fixture.json")).unwrap();
        for (key, value) in [
            ("kyoku", json!(1)),
            ("honba", json!(0)),
            ("kyotaku", json!(0)),
            ("current_player", json!(0)),
            ("turn_count", json!(1)),
            ("is_done", json!(false)),
        ] {
            fixture["snapshot"][key] = value;
        }
        for player in fixture["snapshot"]["players"].as_array_mut().unwrap() {
            for (key, value) in [
                ("score", json!(25000)),
                ("riichi_stage", json!(false)),
                ("double_riichi", json!(false)),
                ("riichi_declaration_index", json!(null)),
                ("kita_tiles", json!([])),
                ("drawn_tile", json!(null)),
            ] {
                player[key] = value;
            }
        }
        let action = json!({"type":"dahai","actor":0,"pai":"9p","tsumogiri":false});
        serde_json::from_value(json!({
            "type":"dahai","actor":0,"pai":"9p","tsumogiri":false,
            "meta":{"show":{"items":[{"prob":probability}],"coach":{
                "snapshot":fixture["snapshot"],"events":[],"actions":[action]
            }}}
        }))
        .unwrap()
    }

    #[test]
    fn threshold_uses_raw_probability_and_includes_exactly_sixty_percent() {
        assert!(request(&response(0.6)).is_some());
        assert!(request(&response(0.5999)).is_some());
        assert!(request(&response(0.60001)).is_none());
        assert!(request(&response(1.1)).is_none());
        assert!(request(&response(-0.1)).is_none());
    }

    #[test]
    fn stale_card_and_missing_probability_do_not_override() {
        let mut resp = response(0.4);
        resp.action = MjaiEvent::None;
        assert!(request(&resp).is_none());
        let mut resp = response(0.4);
        resp.meta.as_mut().unwrap()["show"]["items"][0] = json!({"value":"40%"});
        assert!(request(&resp).is_none());
    }

    #[test]
    fn agreement_disagreement_and_invalid_metrics() {
        let req = request(&response(0.4)).unwrap();
        let mut facts = crate::analysis::coach::analyze_candidates(req).unwrap();
        let shanten = facts.candidates[0].shanten.unwrap();
        facts.helper = Some(json!({"preferred_index":0,"candidates":[{"shanten":shanten}]}));
        assert!(matches!(preferred(&facts), Some(MjaiEvent::Dahai { .. })));
        let mut second = facts.candidates[0].clone();
        second.action = MjaiEvent::None;
        facts.candidates.push(second);
        facts.helper = Some(
            json!({"preferred_index":1,"candidates":[{"shanten":shanten},{"shanten":shanten}]}),
        );
        assert!(matches!(preferred(&facts), Some(MjaiEvent::None)));
        facts.helper.as_mut().unwrap()["candidates"][1]["shanten"] = json!(99);
        assert!(preferred(&facts).is_none());
        facts.helper.as_mut().unwrap()["preferred_index"] = json!(9);
        assert!(preferred(&facts).is_none());
    }
}
