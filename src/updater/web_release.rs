//! Official GitHub HTML fallback when the anonymous REST API is rate-limited.
use super::{
    check::parse_sha256_digest,
    teacher::{self, REPO},
};
use crate::github::{Asset, ReleaseJson};
use anyhow::{ensure, Context, Result};
use std::time::Duration;
const TIMEOUT: Duration = Duration::from_secs(15);

fn release_tag(url: &reqwest::Url) -> Result<String> {
    ensure!(
        url.scheme() == "https" && url.host_str() == Some("github.com"),
        "发布页跳转到了非 GitHub 地址"
    );
    let tag = url
        .path()
        .strip_prefix(&format!("/{REPO}/releases/tag/"))
        .context("无法识别 GitHub 发布页")?;
    ensure!(teacher::valid_tag(tag), "无法识别教师版发布版本");
    Ok(tag.to_owned())
}
fn attr<'a>(tag: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=\"");
    let value = tag.strip_prefix(&prefix).or_else(|| {
        tag.split_once(&format!(" {prefix}"))
            .map(|(_, value)| value)
    })?;
    value.split_once('"').map(|(value, _)| value)
}

fn web_asset(html: &str, tag: &str) -> Result<Asset> {
    ensure!(teacher::valid_tag(tag), "invalid teacher tag");
    let version = tag.strip_prefix("teacher-v").unwrap();
    let name = format!("akagi-teacher-v{version}.exe");
    let path = format!("/{REPO}/releases/download/{tag}/{name}");
    ensure!(
        html.contains(&format!("href=\"{path}\"")),
        "官方发布页缺少新版 EXE"
    );
    let label = format!("Copy to clipboard digest for {name}");
    let mut matches = html.split("<clipboard-copy ").filter_map(|chunk| {
        let node = chunk.split('>').next()?;
        if attr(node, "aria-label") != Some(label.as_str()) {
            return None;
        }
        attr(node, "value").and_then(parse_sha256_digest)
    });
    let digest = matches
        .next()
        .context("官方发布页未提供有效 SHA-256，请前往发布页手动下载")?;
    ensure!(matches.next().is_none(), "发布页存在重复的 EXE 校验信息");
    Ok(Asset {
        name,
        browser_download_url: format!("https://github.com{path}"),
        size: None,
        digest: Some(format!("sha256:{digest}")),
    })
}
async fn limited_text(mut response: reqwest::Response) -> Result<String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= 2 * 1024 * 1024,
            "GitHub 发布页内容超出限制"
        );
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).context("GitHub 发布页不是 UTF-8")
}
pub async fn fetch(client: &reqwest::Client) -> Result<ReleaseJson> {
    let page = client
        .get(format!("https://github.com/{REPO}/releases/latest"))
        .timeout(TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let tag = release_tag(page.url())?;
    drop(page);
    let assets_url = format!("https://github.com/{REPO}/releases/expanded_assets/{tag}");
    let response = client
        .get(&assets_url)
        .timeout(TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    ensure!(
        response.url().as_str() == assets_url,
        "资源页跳转到了非预期地址"
    );
    let mut asset = web_asset(&limited_text(response).await?, &tag)?;
    let response = client
        .head(&asset.browser_download_url)
        .timeout(TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    asset.size = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    teacher::validate_asset(&tag, &asset)?;
    Ok(ReleaseJson {
        tag_name: Some(tag),
        name: None,
        body: None,
        assets: vec![asset],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn html(digest: &str) -> String {
        format!(
            r#"<a href="/{REPO}/releases/download/teacher-v3.7.2.16/akagi-teacher-v3.7.2.16.exe"></a><clipboard-copy aria-label="Copy to clipboard digest for akagi-teacher-v3.7.2.16.exe" value="{digest}"></clipboard-copy>"#
        )
    }
    #[test]
    fn only_accepts_exact_official_release_and_matching_executable_digest() {
        let tag = "teacher-v3.7.2.16";
        assert_eq!(
            release_tag(
                &format!("https://github.com/{REPO}/releases/tag/{tag}")
                    .parse()
                    .unwrap()
            )
            .unwrap(),
            tag
        );
        for url in [
            "https://example.com/xcymm3/Akagi-Teacher/releases/tag/teacher-v3.7.2.16",
            "https://github.com/other/repo/releases/tag/teacher-v3.7.2.16",
            "https://github.com/xcymm3/Akagi-Teacher/releases/tag/teacher-v3.7.2.16-beta",
        ] {
            assert!(release_tag(&url.parse().unwrap()).is_err());
        }
        let digest = format!("sha256:{}", "a".repeat(64));
        assert_eq!(
            web_asset(&html(&digest), tag).unwrap().digest.as_deref(),
            Some(digest.as_str())
        );
        assert!(web_asset(&html("sha256:bad"), tag).is_err());
        assert!(web_asset(
            &html(&digest).replace(
                "clipboard digest for akagi-teacher",
                "clipboard digest for other"
            ),
            tag
        )
        .is_err());
        assert!(web_asset(
            &html(&digest).replace("href=\"/xcymm3", "href=\"https://evil.test/xcymm3"),
            tag
        )
        .is_err());
        assert!(web_asset(&(html(&digest) + &html(&digest)), tag).is_err());
    }
    #[tokio::test]
    #[ignore = "requires live GitHub HTTPS"]
    async fn live_official_web_fallback() {
        let client = crate::github::build_client().unwrap();
        let release = fetch(&client).await.unwrap();
        let tag = release.tag_name.as_deref().unwrap();
        teacher::validate_asset(tag, &release.assets[0]).unwrap();
        println!(
            "official web fallback: {} / {} bytes",
            tag,
            release.assets[0].size.unwrap()
        );
    }
}
