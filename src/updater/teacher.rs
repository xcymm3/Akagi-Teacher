//! Release identity is separate from the upstream Cargo package version.
use super::check::{parse_sha256_digest, UpdateInfo};
use crate::config::{GithubMirrorMode, NetworkConfig};
use crate::github::mirror::Source;
use crate::github::{Asset, ReleaseJson};
use anyhow::{bail, ensure, Context, Result};

pub const REPO: &str = "xcymm3/Akagi-Teacher";
pub const VERSION: &str = "3.7.2.13";

pub fn direct_network() -> NetworkConfig {
    NetworkConfig {
        github_mirror_mode: GithubMirrorMode::Direct,
        github_custom_mirror: String::new(),
    }
}

fn parts(version: &str) -> Option<[u32; 4]> {
    let version = version.strip_prefix("teacher-v").unwrap_or(version);
    let values: Vec<_> = version
        .split('.')
        .map(|p| {
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n = p.parse::<u32>().ok()?;
            if n.to_string() != p {
                return None;
            }
            Some(n)
        })
        .collect::<Option<_>>()?;
    values.try_into().ok()
}

pub fn build_info(
    current: &str,
    triple: &str,
    release: &ReleaseJson,
    source: Source,
) -> Result<Option<UpdateInfo>> {
    ensure!(
        source == Source::Direct,
        "教师版更新必须从 GitHub 直接获取可信元数据"
    );
    let tag = release
        .tag_name
        .as_deref()
        .context("release has no tag_name")?;
    let Some(version) = tag.strip_prefix("teacher-v") else {
        return Ok(None);
    };
    let Some(latest) = parts(tag) else {
        return Ok(None);
    };
    let current_parts = parts(current).context("invalid embedded teacher version")?;
    if latest <= current_parts || triple != "windows-x64" {
        return Ok(None);
    }
    let name = format!("akagi-teacher-v{version}.exe");
    let Some(asset) = release.assets.iter().find(|a| a.name == name) else {
        bail!("新版缺少自动更新所需的独立 EXE，请稍后重试");
    };
    validate_asset(tag, asset)?;
    Ok(Some(UpdateInfo {
        current: current.to_owned(),
        latest_tag: tag.to_owned(),
        latest_version: version.to_owned(),
        body: release.body.clone().unwrap_or_default(),
        html_url: format!("https://github.com/{REPO}/releases/latest"),
        asset_name: name,
        asset_url: asset.browser_download_url.clone(),
        asset_size: asset.size.unwrap_or(0),
        asset_digest_sha256: asset.digest.as_deref().and_then(parse_sha256_digest),
        sig_url: None,
        meta_source: Source::Direct,
    }))
}

pub fn validate_asset(tag: &str, asset: &Asset) -> Result<()> {
    ensure!(
        parts(tag).is_some() && tag.starts_with("teacher-v"),
        "invalid teacher release tag"
    );
    let version = tag.strip_prefix("teacher-v").unwrap();
    let name = format!("akagi-teacher-v{version}.exe");
    ensure!(asset.name == name, "invalid teacher executable name");
    ensure!(
        asset.browser_download_url
            == format!("https://github.com/{REPO}/releases/download/{tag}/{name}"),
        "unexpected teacher download URL"
    );
    ensure!(
        asset
            .digest
            .as_deref()
            .and_then(parse_sha256_digest)
            .is_some(),
        "GitHub 未提供有效 SHA-256，暂不安装该更新"
    );
    ensure!(
        asset.size.is_some_and(|s| s > 0 && s <= 512 * 1024 * 1024),
        "invalid teacher executable size"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(version: &str) -> ReleaseJson {
        let tag = format!("teacher-v{version}");
        let name = format!("akagi-teacher-v{version}.exe");
        ReleaseJson {
            tag_name: Some(tag.clone()),
            name: None,
            body: Some("notes".into()),
            assets: vec![Asset {
                browser_download_url: format!(
                    "https://github.com/{REPO}/releases/download/{tag}/{name}"
                ),
                name,
                size: Some(100),
                digest: Some(format!("sha256:{}", "a".repeat(64))),
            }],
        }
    }
    #[test]
    fn four_part_versions_are_numeric_and_never_downgrade() {
        assert!(build_info(
            "3.7.2.9",
            "windows-x64",
            &release("3.7.2.10"),
            Source::Direct
        )
        .unwrap()
        .is_some());
        for version in ["3.7.2.8", "3.7.2.9", "3.7.2.09", "3.7.2.10-beta", "3.7.2"] {
            assert!(
                build_info("3.7.2.9", "windows-x64", &release(version), Source::Direct)
                    .unwrap()
                    .is_none()
            );
        }
    }
    #[test]
    fn refuses_wrong_origin_missing_digest_or_mirror_metadata() {
        let mut r = release("3.7.2.14");
        assert!(build_info(VERSION, "windows-x64", &r, Source::Mirror).is_err());
        r.assets[0].browser_download_url = "https://example.com/app.exe".into();
        assert!(build_info(VERSION, "windows-x64", &r, Source::Direct).is_err());
        r = release("3.7.2.14");
        r.assets[0].digest = None;
        assert!(build_info(VERSION, "windows-x64", &r, Source::Direct).is_err());
    }
    #[test]
    fn ignores_upstream_tags_and_reports_unfinished_release() {
        let mut r = release("3.7.2.14");
        r.tag_name = Some("v4.0.0".into());
        assert!(build_info(VERSION, "windows-x64", &r, Source::Direct)
            .unwrap()
            .is_none());
        r = release("3.7.2.14");
        r.assets.clear();
        assert!(build_info(VERSION, "windows-x64", &r, Source::Direct).is_err());
    }
}
