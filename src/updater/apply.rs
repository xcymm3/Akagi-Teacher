//! Download a release zip (direct or via mirrors), verify integrity,
//! extract just the binary, atomically swap it into place via
//! `self_replace`, then trigger a restart.
//!
//! Integrity policy: the SHA-256 digest from release metadata is checked
//! when present, but the *trust anchor* is the minisign signature —
//! metadata and bytes may both have come through an untrusted
//! accelerator mirror. When any part of the flow touched a mirror, a
//! valid signature is mandatory; a fully-direct download of an old
//! unsigned release keeps the historical digest-only behaviour.
//!
//! Only the running platform's binary is extracted — the bundled
//! Python+UV runtime tree stays untouched. That's fine for normal patch
//! releases (which only change Rust code); the user is reminded in the
//! UI that runtime-bump releases may require a full reinstall.

use crate::config::NetworkConfig;
use crate::github::mirror::{self, Source};
use crate::github::{
    build_client, download_with_fallback, extract_zip_safe, fetch_text_with_fallback, signing,
};
use crate::updater::check::UpdateInfo;
use crate::updater::error::UpdateError;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tracing::{info as log_info, warn};

/// Top-level entry point called by the `apply_update` IPC command.
/// On success the function does NOT return — `app.restart()` exits the
/// process. Failures map to `UpdateError` so the frontend can decide
/// between a generic toast and a "fall back to release page" hint.
pub async fn download_and_apply(
    app: &AppHandle,
    info: &UpdateInfo,
    net: &NetworkConfig,
) -> Result<(), UpdateError> {
    let teacher_update = info.latest_tag.starts_with("teacher-v");
    if teacher_update {
        validate_teacher_info(info).map_err(UpdateError::from)?;
        ensure_game_idle(app).await?;
    }
    let direct = super::teacher::direct_network();
    let net = if teacher_update { &direct } else { net };
    // Determine the running exe path and verify its parent is writable
    // before we burn bandwidth on a download we can't apply.
    let current_exe = std::env::current_exe()
        .context("std::env::current_exe failed")
        .map_err(UpdateError::from)?;
    let install_dir = current_exe
        .parent()
        .ok_or_else(|| anyhow!("current_exe has no parent"))
        .map_err(UpdateError::from)?
        .to_path_buf();
    if !is_dir_writable(&install_dir) {
        return Err(UpdateError::ReadOnlyInstall { path: install_dir });
    }

    // Stream-download the asset into a tempfile that lives next to the
    // exe so the rename in `self_replace::self_replace` stays on the
    // same filesystem.
    let tempdir = tempfile::Builder::new()
        .prefix(".akagi-update-")
        .tempdir_in(&install_dir)
        .context("create staging dir next to current exe")
        .map_err(UpdateError::from)?;
    let zip_path = tempdir.path().join("release.zip");

    let client = build_client().map_err(UpdateError::from)?;
    let zip_candidates = mirror::candidates(net, &info.asset_url);
    let (zip_source, downloaded_digest) =
        download_with_fallback(&client, &zip_candidates, &zip_path)
            .await
            .map_err(UpdateError::from)?;
    log_info!(
        "update zip downloaded via {zip_source:?} ({} bytes expected)",
        info.asset_size
    );

    if let Some(expected) = info.asset_digest_sha256.as_deref() {
        if !downloaded_digest.eq_ignore_ascii_case(expected) {
            return Err(UpdateError::DigestMismatch);
        }
    }

    // Signature policy. `mirror_involved` is the union of every place
    // untrusted bytes could have entered: the metadata fetch (digest and
    // asset URL fields) and the zip download itself.
    let mirror_involved = info.meta_source == Source::Mirror || zip_source == Source::Mirror;
    match info.sig_url.as_deref() {
        Some(sig_url) => {
            let sig_candidates = mirror::candidates(net, sig_url);
            let (sig_text, sig_source) = fetch_text_with_fallback(&client, &sig_candidates)
                .await
                .context("fetch release signature")
                .map_err(UpdateError::from)?;
            log_info!("release signature fetched via {sig_source:?}");
            // The expected trusted comment is computed from the version
            // the release CLAIMS to be and our own platform triple —
            // never from the metadata's asset name. Forged metadata that
            // pairs a fake newer tag with a genuine (validly signed)
            // older zip then fails right here: no signature exists whose
            // trusted comment names the fake version. This ties the
            // signature to `scripts/package-zip.sh`'s naming; if a
            // release's tag and Cargo version ever disagree, the update
            // fails closed to the release page.
            let triple = crate::updater::check::triple_for_current_platform()
                .ok_or(UpdateError::UnsupportedPlatform)?;
            let expected_name =
                crate::updater::check::expected_asset_name(&info.latest_version, triple);
            if let Err(e) = signing::verify_release_asset(&zip_path, &sig_text, &expected_name) {
                warn!("release signature verification failed: {e:#}");
                return Err(UpdateError::SignatureInvalid);
            }
        }
        None if mirror_involved => {
            // Unsigned release + untrusted transport: refuse. The user
            // can still update manually from the release page.
            return Err(UpdateError::SignatureMissing);
        }
        None => {
            // Old unsigned release over a direct connection — the
            // pre-signing trust level, digest check above still applies.
        }
    }

    let new_binary = if teacher_update {
        let binary = tempdir.path().join("akagi-teacher.exe");
        prepare_teacher_binary(info, &zip_path, &binary).map_err(UpdateError::from)?;
        binary
    } else {
        // Extract the whole zip into a sibling dir, then locate the binary
        // entry. The release zip wraps everything in a single
        // `akagi-<version>-<triple>/` directory, so the binary lives one
        // level down. We don't extract the runtime tree — too large and the
        // user is told to manually reinstall when the runtime version
        // changes.
        let extract_dir = tempdir.path().join("extracted");
        std::fs::create_dir(&extract_dir)
            .with_context(|| format!("mkdir {}", extract_dir.display()))
            .map_err(UpdateError::from)?;
        extract_zip_safe(&zip_path, &extract_dir)
            .context("extract release zip")
            .map_err(UpdateError::from)?;

        let binary_name = current_exe
            .file_name()
            .ok_or_else(|| anyhow!("current_exe has no file name"))
            .map_err(UpdateError::from)?
            .to_owned();
        find_binary(&extract_dir, &binary_name).ok_or(UpdateError::NoMatchingAsset)?
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&new_binary, std::fs::Permissions::from_mode(0o755));
    }

    // Atomic in-place swap. On Unix this is a `rename` over the
    // currently-running ELF/Mach-O (the kernel keeps the running inode
    // alive). On Windows it's the documented copy + delete-on-close
    // dance — see the self_replace crate docs for the gory details.
    if teacher_update {
        ensure_game_idle(app).await?;
    }
    self_replace::self_replace(&new_binary)
        .context("self_replace::self_replace")
        .map_err(UpdateError::from)?;

    // restart exits without unwinding, so clean our download/staging copies
    // explicitly instead of leaving large update folders after every upgrade.
    drop(tempdir);

    // Trigger restart. The call shuts the process down and re-execs the
    // (now swapped) binary, so anything after this point in the source
    // is unreachable.
    app.restart();
}

/// No active round may be interrupted by the updater's restart.
async fn ensure_game_idle(app: &AppHandle) -> Result<(), UpdateError> {
    let state = app.state::<crate::ipc::AppState>();
    if state
        .game_tracker
        .lock()
        .await
        .snapshot()
        .is_some_and(|s| !s.is_done)
    {
        return Err(UpdateError::Other {
            message: "当前牌局尚未结束，请结束牌局后再更新".into(),
        });
    }
    Ok(())
}

fn validate_teacher_info(info: &UpdateInfo) -> Result<()> {
    anyhow::ensure!(
        info.meta_source == Source::Direct,
        "untrusted teacher update metadata"
    );
    super::teacher::validate_asset(
        &info.latest_tag,
        &crate::github::Asset {
            name: info.asset_name.clone(),
            browser_download_url: info.asset_url.clone(),
            size: Some(info.asset_size),
            digest: info
                .asset_digest_sha256
                .as_ref()
                .map(|h| format!("sha256:{h}")),
        },
    )
}

/// The destination name is independent of the currently running EXE's name.
/// No runtime, profile or config files are read or extracted here.
fn prepare_teacher_binary(info: &UpdateInfo, download: &Path, destination: &Path) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    validate_teacher_info(info)?;
    let mut file = std::fs::File::open(download)?;
    anyhow::ensure!(
        file.metadata()?.len() == info.asset_size,
        "downloaded executable size mismatch"
    );
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)?;
    anyhow::ensure!(&dos[..2] == b"MZ", "update is not a Windows executable");
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    anyhow::ensure!(
        offset >= 64 && offset + 26 <= info.asset_size,
        "invalid PE header offset"
    );
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0u8; 26];
    file.read_exact(&mut pe)?;
    anyhow::ensure!(
        &pe[..4] == b"PE\0\0" && u16::from_le_bytes([pe[4], pe[5]]) == 0x8664,
        "update is not a Windows x64 executable"
    );
    let flags = u16::from_le_bytes([pe[22], pe[23]]);
    anyhow::ensure!(
        flags & 2 != 0 && flags & 0x2000 == 0 && pe[24..26] == [0x0b, 0x02],
        "invalid executable type"
    );
    drop(file);
    std::fs::copy(download, destination)?;
    Ok(())
}

/// Returns true if `dir` looks writable. We do an explicit write-probe
/// rather than relying on `metadata().permissions().readonly()` because
/// (a) on Unix permissions don't capture mount-level read-only flags
/// (squashfs, AppImage), and (b) on Windows readonly directories are
/// not actually a thing — ACLs are richer.
fn is_dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".akagi-write-probe");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Walk `dir` looking for an entry whose file name matches `binary_name`.
/// The release zip wraps everything in a single top-level
/// `akagi-<version>-<triple>/` directory so we have to descend at least
/// one level — but we keep the walk bounded to avoid scanning the whole
/// runtime tree if the layout ever changes.
fn find_binary(dir: &Path, binary_name: &std::ffi::OsStr) -> Option<PathBuf> {
    // Direct hit at the top level — handles a hypothetical future
    // layout that drops the wrapping directory.
    let direct = dir.join(binary_name);
    if direct.is_file() {
        return Some(direct);
    }
    // Otherwise descend exactly one level. The release zip's wrapping
    // dir is the only thing we expect at the root, so this is enough.
    for entry in std::fs::read_dir(dir).ok()? {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join(binary_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let f = File::create(path).unwrap();
        let mut z = ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        for (name, body) in entries {
            z.start_file(name.to_string(), opts).unwrap();
            z.write_all(body).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn find_binary_locates_inside_wrapped_dir() {
        let tmp = TempDir::new().unwrap();
        let zip = tmp.path().join("a.zip");
        make_zip(
            &zip,
            &[
                ("akagi-3.0.12-linux-x64/akagi", b"#!/bin/sh\nexit 0\n"),
                ("akagi-3.0.12-linux-x64/README.txt", b"hello"),
                (
                    "akagi-3.0.12-linux-x64/runtime/python/keep.txt",
                    b"not the binary",
                ),
            ],
        );
        let out = TempDir::new().unwrap();
        extract_zip_safe(&zip, out.path()).unwrap();
        let found = find_binary(out.path(), std::ffi::OsStr::new("akagi"))
            .expect("should find the binary one level down");
        assert!(found.ends_with("akagi-3.0.12-linux-x64/akagi"));
    }

    #[test]
    fn find_binary_returns_none_when_absent() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("akagi-3.0.12-linux-x64")).unwrap();
        std::fs::write(tmp.path().join("akagi-3.0.12-linux-x64/README.txt"), b"hi").unwrap();
        assert!(find_binary(tmp.path(), std::ffi::OsStr::new("akagi")).is_none());
    }

    #[test]
    fn find_binary_prefers_direct_hit() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("akagi"), b"top-level").unwrap();
        std::fs::create_dir_all(tmp.path().join("subdir")).unwrap();
        std::fs::write(tmp.path().join("subdir/akagi"), b"nested").unwrap();
        let found = find_binary(tmp.path(), std::ffi::OsStr::new("akagi")).unwrap();
        assert_eq!(found, tmp.path().join("akagi"));
    }

    #[test]
    fn is_dir_writable_for_tempdir() {
        let tmp = TempDir::new().unwrap();
        assert!(is_dir_writable(tmp.path()));
    }
}

#[cfg(test)]
mod teacher_update_tests {
    use super::*;
    fn executable() -> Vec<u8> {
        let mut bytes = vec![0u8; 128];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes());
        bytes[86..88].copy_from_slice(&2u16.to_le_bytes());
        bytes[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
        bytes
    }
    fn info(size: u64) -> UpdateInfo {
        UpdateInfo { current: "3.7.2.8".into(), latest_tag: "teacher-v3.7.2.9".into(), latest_version: "3.7.2.9".into(),
            body: String::new(), html_url: String::new(), asset_name: "akagi-teacher-v3.7.2.9.exe".into(),
            asset_url: "https://github.com/xcymm3/Akagi-Teacher/releases/download/teacher-v3.7.2.9/akagi-teacher-v3.7.2.9.exe".into(),
            asset_size: size, asset_digest_sha256: Some("a".repeat(64)), sig_url: None, meta_source: Source::Direct }
    }
    #[test]
    fn staging_supports_old_exe_names_and_preserves_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("download");
        let config = dir.path().join("config.toml");
        std::fs::write(&config, "keep configuration").unwrap();
        let bytes = executable();
        std::fs::write(&raw, &bytes).unwrap();
        let target = dir.path().join("akagi-teacher-v3.7.2.8.exe");
        prepare_teacher_binary(&info(bytes.len() as u64), &raw, &target).unwrap();
        assert_eq!(std::fs::read(target).unwrap(), bytes);
        assert_eq!(
            std::fs::read_to_string(config).unwrap(),
            "keep configuration"
        );
    }
    #[test]
    fn rejects_truncated_wrong_architecture_and_non_executable_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("download");
        let target = dir.path().join("new.exe");
        let mut bytes = executable();
        std::fs::write(&raw, &bytes).unwrap();
        assert!(prepare_teacher_binary(&info(129), &raw, &target).is_err());
        bytes[68] = 0x4c;
        bytes[69] = 0x01;
        std::fs::write(&raw, &bytes).unwrap();
        assert!(prepare_teacher_binary(&info(128), &raw, &target).is_err());
        std::fs::write(&raw, vec![0u8; 128]).unwrap();
        assert!(prepare_teacher_binary(&info(128), &raw, &target).is_err());
        assert!(!target.exists());
    }
}
