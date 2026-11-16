//! Bounded page diagnostics; wire input verification remains authoritative.
use anyhow::{Context, Result};
use chromiumoxide::page::Page;
use serde::Deserialize;
use std::time::Duration;

const SCRIPT: &str = include_str!("page_health.js");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub canvas: bool,
    pub hidden: bool,
    pub width: f64,
    pub height: f64,
    pub context_lost: bool,
    pub frames: u64,
    pub frame_age_ms: Option<f64>,
    #[serde(flatten)]
    pub details: serde_json::Map<String, serde_json::Value>,
}
impl Health {
    pub fn blocked_reason(&self) -> Option<&'static str> {
        if !self.canvas || self.width <= 0.0 || self.height <= 0.0 {
            Some("canvas unavailable")
        } else if self.hidden {
            Some("page hidden")
        } else if self.context_lost {
            Some("WebGL context lost")
        } else {
            None
        }
    }
}

pub async fn install(page: &Page) -> Result<()> {
    tokio::time::timeout(
        Duration::from_millis(800),
        page.evaluate_on_new_document(SCRIPT),
    )
    .await
    .context("install future page diagnostics timeout")??;
    // Also cover an already-loaded external browser tab. Installation is idempotent.
    tokio::time::timeout(Duration::from_millis(800), page.evaluate(SCRIPT))
        .await
        .context("install current page diagnostics timeout")??;
    Ok(())
}

pub async fn probe(page: &Page, arm_ms: Option<u32>) -> Result<Option<Health>> {
    let method = match arm_ms {
        Some(ms) => format!("prepare({ms})"),
        None => "snapshot()".into(),
    };
    let expression =
        format!("(()=>{{const h=window.__akagiTeacherHealth;return h?h.{method}:null;}})()");
    let result = tokio::time::timeout(Duration::from_millis(400), page.evaluate(expression))
        .await
        .context("page health timeout")??;
    result
        .value()
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()).context("decode page health"))
        .transpose()
}

pub async fn finish(page: &Page) {
    let _ = tokio::time::timeout(
        Duration::from_millis(400),
        page.evaluate("(()=>{const h=window.__akagiTeacherHealth;return h?h.finish():null;})()"),
    )
    .await;
}

pub async fn log_health(page: &Page, stage: &str) {
    match probe(page, None).await {
        Ok(Some(h)) => {
            tracing::warn!(stage, health = ?h, details = ?h.details, "autoplay: page diagnostics (not proof of accepted input)")
        }
        Ok(None) => {}
        Err(e) => tracing::debug!(stage, "autoplay: page diagnostics unavailable: {e:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rendering_stall_is_not_conclusive_failure() {
        let mut h: Health = serde_json::from_value(serde_json::json!({
            "canvas":true,"hidden":false,"width":1600,"height":900,
            "contextLost":false,"frames":0,"frameAgeMs":10000
        }))
        .unwrap();
        assert_eq!(h.blocked_reason(), None);
        h.hidden = true;
        assert_eq!(h.blocked_reason(), Some("page hidden"));
        h.hidden = false;
        h.context_lost = true;
        assert_eq!(h.blocked_reason(), Some("WebGL context lost"));
        h.context_lost = false;
        h.width = 0.0;
        assert_eq!(h.blocked_reason(), Some("canvas unavailable"));
    }
}
