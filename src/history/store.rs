//! `HistoryStore` — JSONL-backed persistent record store.
//!
//! Layout under the configured history root:
//!
//! ```text
//! <root>/
//!   index.jsonl              # one JSON-encoded GameRecord per line
//!   games/
//!     <id>.mjai.jsonl        # full event stream copy, one MjaiEvent per line
//! ```
//!
//! All writes funnel through `inner.lock` so concurrent recorders /
//! commands produce well-formed JSONL even when interleaved. Reads
//! re-open the index file each time — the index is small (one short
//! line per game) so this is fine for the foreseeable scale.
//!
//! No backfill: we never read pre-existing mjai logs from
//! `<log_dir>/majsoul/*.mjai.jsonl`. The history root only ever contains
//! games this recorder has finalised.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use tracing::warn;

use crate::schema::{GameRecord, HistoryEventLog, HistoryFilter, MjaiEvent};

const INDEX_FILE: &str = "index.jsonl";
const GAMES_SUBDIR: &str = "games";

/// Sentinel: a `limit` of 0 means "no cap, return everything that
/// passes the filter". The History tab loads the full set on startup
/// for in-memory charting; explicit pagination is for callers that
/// genuinely want a window.
pub const NO_LIMIT: u32 = 0;

pub struct HistoryStore {
    root: PathBuf,
    /// Serialises writes to `index.jsonl` and the per-game files.
    /// Reads bypass this lock — the index is opened fresh each time.
    write_lock: Mutex<()>,
}

impl HistoryStore {
    /// Open (or create) the store at `root`. Creates `<root>` and
    /// `<root>/games/` if they don't already exist.
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join(GAMES_SUBDIR))
            .with_context(|| format!("failed to create history dir {}", root.display()))?;
        Ok(Self {
            root,
            write_lock: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }

    fn game_log_path(&self, id: &str) -> PathBuf {
        self.root
            .join(GAMES_SUBDIR)
            .join(format!("{id}.mjai.jsonl"))
    }

    /// Persist a finalised game: write the full event stream as
    /// `games/<id>.mjai.jsonl` and append the summary record to
    /// `index.jsonl`. On failure the writes are best-effort cleaned up.
    pub fn append(&self, record: &GameRecord, events: &HistoryEventLog) -> Result<()> {
        let _g = self.write_lock.lock().expect("history write lock poisoned");

        let game_path = self.game_log_path(&record.id);
        write_jsonl_events(&game_path, events)
            .with_context(|| format!("failed to write game log {}", game_path.display()))?;

        if let Err(e) = self.append_index_locked(record) {
            // Roll back the orphan game log so re-running the same id
            // doesn't trip the dedup check.
            let _ = fs::remove_file(&game_path);
            return Err(e);
        }

        Ok(())
    }

    fn append_index_locked(&self, record: &GameRecord) -> Result<()> {
        let path = self.index_path();
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        let line = serde_json::to_string(record).context("failed to serialise GameRecord")?;
        writeln!(f, "{line}").with_context(|| format!("failed to write to {}", path.display()))?;
        f.sync_data().ok();
        Ok(())
    }

    /// Read the full index — newest-first if the index is append-only
    /// chronological (it is). Lines that fail to parse are warned and
    /// skipped; corruption never poisons the rest of the listing.
    pub fn read_all(&self) -> Result<Vec<GameRecord>> {
        let path = self.index_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let f = File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
        let mut out = Vec::new();
        for (lineno, line) in BufReader::new(f).lines().enumerate() {
            let line = line.with_context(|| format!("read error in {}", path.display()))?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<GameRecord>(&line) {
                Ok(r) => out.push(r),
                Err(e) => warn!(
                    target: "akagi::history",
                    "skipping malformed index line {lineno} in {}: {e}",
                    path.display()
                ),
            }
        }
        Ok(out)
    }

    /// Filtered + paginated listing, newest-first by `started_at`.
    /// `limit == NO_LIMIT` (0) returns every match; otherwise caps the
    /// result to that many records after `offset`.
    pub fn list(&self, filter: &HistoryFilter, limit: u32, offset: u32) -> Result<Vec<GameRecord>> {
        let mut all = self.read_all()?;
        // Newest first.
        all.sort_by_key(|b| std::cmp::Reverse(b.started_at));
        let off = offset as usize;
        let it = all.into_iter().filter(|r| filter.matches(r)).skip(off);
        Ok(if limit == NO_LIMIT {
            it.collect()
        } else {
            it.take(limit as usize).collect()
        })
    }

    /// Single record by id, or `None` if missing.
    pub fn get(&self, id: &str) -> Result<Option<GameRecord>> {
        Ok(self.read_all()?.into_iter().find(|r| r.id == id))
    }

    /// Read the full mjai event log for a game.
    pub fn get_events(&self, id: &str) -> Result<Option<HistoryEventLog>> {
        let path = self.game_log_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let f = File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
        let mut out = Vec::new();
        for (lineno, line) in BufReader::new(f).lines().enumerate() {
            let line = line.with_context(|| format!("read error in {}", path.display()))?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<MjaiEvent>(&line) {
                Ok(ev) => out.push(ev),
                Err(e) => warn!(
                    target: "akagi::history",
                    "skipping malformed event line {lineno} in {}: {e}",
                    path.display()
                ),
            }
        }
        Ok(Some(out))
    }

    /// Remove the record + its mjai.jsonl. Rewrites the index without
    /// the matching entry. Returns true if a record was removed.
    pub fn delete(&self, id: &str) -> Result<bool> {
        let _g = self.write_lock.lock().expect("history write lock poisoned");
        let mut all = self.read_all()?;
        let before = all.len();
        all.retain(|r| r.id != id);
        let removed = all.len() < before;
        if removed {
            self.rewrite_index_locked(&all)?;
            let game_path = self.game_log_path(id);
            if game_path.exists() {
                fs::remove_file(&game_path)
                    .with_context(|| format!("failed to remove {}", game_path.display()))?;
            }
        }
        Ok(removed)
    }

    fn rewrite_index_locked(&self, records: &[GameRecord]) -> Result<()> {
        let path = self.index_path();
        // Atomic-ish rewrite: write to a tmp sibling, then rename.
        let tmp = path.with_extension("jsonl.tmp");
        {
            let mut f = File::create(&tmp)
                .with_context(|| format!("failed to create {}", tmp.display()))?;
            for r in records {
                let line = serde_json::to_string(r).context("failed to serialise GameRecord")?;
                writeln!(f, "{line}")
                    .with_context(|| format!("failed to write to {}", tmp.display()))?;
            }
            f.sync_data().ok();
        }
        fs::rename(&tmp, &path)
            .with_context(|| format!("failed to rename {} -> {}", tmp.display(), path.display()))
    }
}

fn write_jsonl_events(path: &Path, events: &HistoryEventLog) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = File::create(path)?;
    for ev in events {
        let line = serde_json::to_string(ev).context("failed to serialise MjaiEvent")?;
        writeln!(f, "{line}")?;
    }
    f.sync_data().ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{GameStats, KyokuMode, Platform};
    use chrono::{Duration, Utc};
    use tempfile::TempDir;

    fn mk_record(id: &str, offset_secs: i64) -> GameRecord {
        let now = Utc::now();
        GameRecord {
            id: id.into(),
            started_at: now + Duration::seconds(offset_secs),
            ended_at: now + Duration::seconds(offset_secs + 600),
            platform: Platform::Majsoul,
            num_players: 4,
            kyoku_mode: KyokuMode::EastOnly,
            names: vec!["A".into(), "B".into(), "C".into(), "D".into()],
            our_seat: Some(0),
            final_scores: vec![30000, 25000, 25000, 20000],
            final_ranks: vec![1, 2, 3, 4],
            our_rank: Some(1),
            our_delta: Some(5000),
            our_rank_points: None,
            stats: GameStats::default(),
            match_info: None,
            log_path: format!("games/{id}.mjai.jsonl"),
        }
    }

    fn sample_events() -> HistoryEventLog {
        vec![
            MjaiEvent::StartGame {
                names: vec!["A".into(), "B".into(), "C".into(), "D".into()],
                kyoku_first: Some(0),
                aka_flag: Some(true),
                id: Some(0),
                num_players: 4,
                game_meta: None,
            },
            MjaiEvent::end_game(),
        ]
    }

    #[test]
    fn append_then_list_round_trip() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();

        let r1 = mk_record("AAA", 0);
        let r2 = mk_record("BBB", 100);
        store.append(&r1, &sample_events()).unwrap();
        store.append(&r2, &sample_events()).unwrap();

        let all = store.list(&HistoryFilter::default(), NO_LIMIT, 0).unwrap();
        assert_eq!(all.len(), 2);
        // Newest first.
        assert_eq!(all[0].id, "BBB");
        assert_eq!(all[1].id, "AAA");
    }

    #[test]
    fn filter_by_platform() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();
        let mut r = mk_record("X", 0);
        store.append(&r, &sample_events()).unwrap();
        r.id = "Y".into();
        r.platform = Platform::Tenhou;
        store.append(&r, &sample_events()).unwrap();

        let filter = HistoryFilter {
            platform: Some(Platform::Majsoul),
            ..Default::default()
        };
        let out = store.list(&filter, NO_LIMIT, 0).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "X");
    }

    #[test]
    fn pagination_offset_and_limit() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();
        for i in 0..5 {
            store
                .append(&mk_record(&format!("R{i}"), i * 100), &sample_events())
                .unwrap();
        }
        let page = store.list(&HistoryFilter::default(), 2, 1).unwrap();
        assert_eq!(page.len(), 2);
        // newest first: R4, R3, R2, R1, R0; offset 1 limit 2 → [R3, R2].
        assert_eq!(page[0].id, "R3");
        assert_eq!(page[1].id, "R2");
    }

    #[test]
    fn delete_removes_record_and_log() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();
        let r = mk_record("DEL", 0);
        store.append(&r, &sample_events()).unwrap();
        let log_path = store.game_log_path(&r.id);
        assert!(log_path.exists());

        let removed = store.delete("DEL").unwrap();
        assert!(removed);
        assert!(!log_path.exists());
        assert!(store.get("DEL").unwrap().is_none());
    }

    #[test]
    fn delete_unknown_id_no_op() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .append(&mk_record("KEEP", 0), &sample_events())
            .unwrap();
        let removed = store.delete("NOPE").unwrap();
        assert!(!removed);
        assert_eq!(store.read_all().unwrap().len(), 1);
    }

    #[test]
    fn get_events_returns_full_stream() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();
        let r = mk_record("EV", 0);
        let events = sample_events();
        store.append(&r, &events).unwrap();
        let back = store.get_events("EV").unwrap().unwrap();
        assert_eq!(back, events);
    }

    #[test]
    fn malformed_index_line_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let store = HistoryStore::new(tmp.path().to_path_buf()).unwrap();
        store.append(&mk_record("OK", 0), &sample_events()).unwrap();
        // Corrupt the file: append a garbage line.
        {
            let mut f = OpenOptions::new()
                .append(true)
                .open(store.index_path())
                .unwrap();
            writeln!(f, "{{not valid json").unwrap();
        }
        let out = store.list(&HistoryFilter::default(), 100, 0).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "OK");
    }
}
