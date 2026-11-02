use std::{env, path::PathBuf};

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));

    prost_build::Config::new()
        .type_attribute(".", "#[allow(dead_code)]")
        .file_descriptor_set_path(out_dir.join("liqi_desc.bin"))
        .compile_protos(
            &["src/bridge/majsoul/proto/liqi.proto"],
            &["src/bridge/majsoul/proto/"],
        )
        .expect("failed to compile liqi.proto");

    println!("cargo:rerun-if-changed=src/bridge/majsoul/proto/liqi.proto");
    println!("cargo:rerun-if-changed=build.rs");

    // Surface the build target triple to runtime code so it can pick the
    // right bundled python-build-standalone / uv binary out of the Tauri
    // resource dir. Cargo only exposes this via the `TARGET` env var at
    // build time; we forward it as `TARGET_TRIPLE` for the binary.
    let target = env::var("TARGET").expect("TARGET not set by cargo");
    println!("cargo:rustc-env=TARGET_TRIPLE={target}");

    // Compile a self-contained analysis-only Go helper and embed it in Akagi.
    // No Go installation is needed on the end user's computer.
    let (goos, goarch) = match target.as_str() {
        "x86_64-pc-windows-msvc" => ("windows", "amd64"),
        "aarch64-pc-windows-msvc" => ("windows", "arm64"),
        "x86_64-unknown-linux-gnu" => ("linux", "amd64"),
        "aarch64-unknown-linux-gnu" => ("linux", "arm64"),
        "x86_64-apple-darwin" => ("darwin", "amd64"),
        "aarch64-apple-darwin" => ("darwin", "arm64"),
        _ => panic!("Go coach: unsupported build target {target}"),
    };
    let helper = out_dir.join(if goos == "windows" {
        "akagi-coach-core.exe"
    } else {
        "akagi-coach-core"
    });
    let go = env::var("GO").unwrap_or_else(|_| "go".into());
    let status = std::process::Command::new(go)
        .current_dir("coach-go")
        .env("CGO_ENABLED", "0")
        .env("GOOS", goos)
        .env("GOARCH", goarch)
        .args([
            "build",
            "-mod=readonly",
            "-trimpath",
            "-ldflags=-s -w",
            "-o",
        ])
        .arg(&helper)
        .arg("./cmd/coach")
        .status()
        .expect("Go coach build requires Go >= 1.23; install Go or set GO to its executable");
    assert!(status.success(), "Go coach compilation failed");
    println!("cargo:rustc-env=AKAGI_COACH_BINARY={}", helper.display());
    println!("cargo:rerun-if-changed=coach-go");
    println!("cargo:rerun-if-env-changed=GO");
    tauri_build::build();
}
