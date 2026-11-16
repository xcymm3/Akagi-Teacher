//! Teacher update transport: bounded headers/body, byte progress and cancellation.
use super::UpdateError;
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::atomic::{AtomicU8, Ordering},
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, sync::watch};

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    pub stage: &'static str,
    pub downloaded: u64,
    pub total: u64,
}

pub struct ApplyControl {
    phase: AtomicU8,
    cancelled: watch::Sender<u64>,
}
impl Default for ApplyControl {
    fn default() -> Self {
        let (cancelled, _) = watch::channel(0);
        Self {
            phase: AtomicU8::new(0),
            cancelled,
        }
    }
}
pub struct ApplyGuard<'a>(&'a ApplyControl);
impl Drop for ApplyGuard<'_> {
    fn drop(&mut self) {
        self.0.phase.store(0, Ordering::SeqCst);
    }
}
impl ApplyControl {
    /// Caller holds updater_lock. Subscription precedes enabling cancellation.
    pub fn begin(&self) -> (ApplyGuard<'_>, watch::Receiver<u64>) {
        let receiver = self.cancelled.subscribe();
        self.phase.store(1, Ordering::SeqCst);
        (ApplyGuard(self), receiver)
    }
    pub fn cancel(&self) -> bool {
        if self
            .phase
            .compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.cancelled.send_modify(|n| *n = n.wrapping_add(1));
            true
        } else {
            self.phase.load(Ordering::SeqCst) == 2
        }
    }
    pub fn check(&self) -> std::result::Result<(), UpdateError> {
        if self.phase.load(Ordering::SeqCst) == 2 {
            Err(UpdateError::Cancelled)
        } else {
            Ok(())
        }
    }
    /// Cancellation and the first write to the installed EXE are mutually exclusive.
    pub fn commit(&self) -> std::result::Result<(), UpdateError> {
        self.phase
            .compare_exchange(1, 3, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| UpdateError::Cancelled)
    }
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub headers: Duration,
    pub idle: Duration,
    pub total: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            headers: Duration::from_secs(20),
            idle: Duration::from_secs(30),
            total: Duration::from_secs(600),
        }
    }
}
/// Writes only into the updater's temporary directory. The caller checks the
/// trusted digest; no network response can replace an installed executable here.
pub async fn download<F: FnMut(u64, u64)>(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    expected: u64,
    mut progress: F,
    limits: Limits,
) -> Result<String> {
    let transfer = async {
        anyhow::ensure!(
            expected > 0 && expected <= 512 * 1024 * 1024,
            "invalid update length"
        );
        let mut response = tokio::time::timeout(
            limits.headers,
            client.get(url).header("Accept-Encoding", "identity").send(),
        )
        .await
        .context("等待下载服务器响应超时，请检查 GitHub Release/CDN 连接，或手动下载")?
        .context("连接更新下载服务器失败")?
        .error_for_status()
        .context("下载服务器返回错误")?;
        if let Some(length) = response.content_length() {
            anyhow::ensure!(length == expected, "下载响应长度与发布记录不符");
        }
        let mut file = tokio::fs::File::create(path)
            .await
            .context("创建更新临时文件失败")?;
        let mut digest = Sha256::new();
        let mut downloaded = 0u64;
        let mut last = Instant::now();
        progress(0, expected);
        loop {
            let chunk = tokio::time::timeout(limits.idle, response.chunk())
                .await
                .context("下载长时间没有收到数据，已停止；可重试或手动下载")?
                .context("读取更新数据失败")?;
            let Some(chunk) = chunk else { break };
            let first = downloaded == 0;
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .context("download size overflow")?;
            anyhow::ensure!(
                downloaded <= expected,
                "更新文件超过发布记录大小，已停止下载"
            );
            file.write_all(&chunk)
                .await
                .context("写入更新临时文件失败")?;
            digest.update(&chunk);
            if first || downloaded == expected || last.elapsed() >= Duration::from_millis(250) {
                progress(downloaded, expected);
                last = Instant::now();
            }
        }
        anyhow::ensure!(
            downloaded == expected,
            "更新文件未下载完整：{downloaded}/{expected} 字节"
        );
        file.flush().await.context("刷新更新临时文件失败")?;
        Ok(digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>())
    };
    tokio::time::timeout(limits.total, transfer)
        .await
        .context("更新下载超过总时限，已停止；请重试或手动下载")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpListener};
    async fn server(
        reply: &'static [u8],
        delay_headers: bool,
        stall_body: bool,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).await;
            if delay_headers {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            let _ = stream.write_all(reply).await;
            if stall_body {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
        (format!("http://{addr}/asset"), task)
    }
    fn limits() -> Limits {
        Limits {
            headers: Duration::from_millis(150),
            idle: Duration::from_millis(150),
            total: Duration::from_secs(2),
        }
    }
    #[tokio::test]
    async fn progress_and_digest_match_written_bytes() {
        let (url, task) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest",
            false,
            false,
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial");
        let mut reports = vec![];
        let digest = download(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &url,
            &path,
            4,
            |n, t| reports.push((n, t)),
            limits(),
        )
        .await
        .unwrap();
        assert_eq!(
            digest,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
        assert_eq!(reports.first(), Some(&(0, 4)));
        assert_eq!(reports.last(), Some(&(4, 4)));
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"test");
        task.await.unwrap();
    }
    #[tokio::test]
    async fn stalled_headers_and_body_fail_with_actionable_errors() {
        for (reply, headers, body, want) in [
            (b"".as_slice(), true, false, "响应超时"),
            (
                b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nt".as_slice(),
                false,
                true,
                "没有收到数据",
            ),
        ] {
            let (url, task) = server(reply, headers, body).await;
            let dir = tempfile::tempdir().unwrap();
            let e = download(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &url,
                &dir.path().join("partial"),
                4,
                |_, _| {},
                limits(),
            )
            .await
            .unwrap_err();
            assert!(format!("{e:#}").contains(want), "{e:#}");
            task.abort();
        }
    }
    #[tokio::test]
    async fn rejects_mismatched_lengths_and_total_timeout() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (url, task) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ntoolarge",
            false,
            false,
        )
        .await;
        assert!(download(
            &client,
            &url,
            &dir.path().join("partial"),
            4,
            |_, _| {},
            limits()
        )
        .await
        .is_err());
        task.abort();
        let (url, task) = server(b"", true, false).await;
        let e = download(
            &client,
            &url,
            &dir.path().join("partial"),
            4,
            |_, _| {},
            Limits {
                headers: Duration::from_secs(3),
                total: Duration::from_millis(100),
                ..limits()
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{e:#}").contains("总时限"));
        task.abort();
    }
    #[test]
    fn cancellation_cannot_race_installation_or_poison_next_attempt() {
        let control = ApplyControl::default();
        assert!(!control.cancel());
        {
            let (_guard, mut rx) = control.begin();
            assert!(control.cancel());
            assert!(rx.has_changed().unwrap());
            rx.borrow_and_update();
            assert!(control.commit().is_err());
        }
        let (_guard, rx) = control.begin();
        assert!(!rx.has_changed().unwrap());
        assert!(control.commit().is_ok());
        assert!(!control.cancel());
    }
}
