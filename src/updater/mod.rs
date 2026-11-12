//! Teacher release update checker + self-replace flow.
//! `teacher` defines the four-part release identity and authenticated EXE assets.
//! Teacher metadata and downloads use direct GitHub HTTPS with mandatory SHA-256.
//!
//! Layered for testability:
//!
//! - [`check`] holds pure version-comparison helpers (`is_newer`,
//!   `pick_release_asset`, `triple_for_current_platform`,
//!   `build_update_info`) plus the single async entry point
//!   `check_for_update` that calls into the GitHub API (directly or via
//!   accelerator mirrors, per the `[network]` config).
//! - [`apply`] streams the matching release zip (with mirror fallback),
//!   verifies SHA-256 against `asset_digest_sha256` (when GitHub
//!   provides it) plus the release's minisign signature (mandatory
//!   whenever a mirror was involved — see `github::signing`), extracts
//!   the platform binary, and swaps it via `self_replace::self_replace`
//!   before triggering `AppHandle::restart`.
//! - [`error`] surfaces typed errors so the frontend can fall back to
//!   "Open release page" on `ReadOnlyInstall` / `UnsupportedPlatform`
//!   without showing a scary generic message.
//!
//! The Tauri IPC commands `check_for_update` and `apply_update` live in
//! `src/ipc/commands.rs`; both are guarded by `AppState::updater_lock`
//! so two concurrent invocations can't race the file rename.

pub mod apply;
pub mod check;
pub mod error;
pub mod teacher;

pub use check::{check_for_update, UpdateInfo};
pub use error::UpdateError;
