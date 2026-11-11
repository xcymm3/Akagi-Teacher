#!/usr/bin/env bash
# Compile glue against the unchanged original Akagi source, in an external build dir.
set -euo pipefail
ROOT=${AKAGI_ROOT:-/disk2/Akagi}
CODE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SOURCE=${AKAGI_SOURCE:-$ROOT/source}
BUILD="$ROOT/experiments/riichienv-01/stage3/bridge-build"
PY="$ROOT/env/riichienv-01/bin/python"
test "$(git -C "$SOURCE" rev-parse HEAD)" = bea9b569277701cd311c428cbf091f385c45bad2
test -z "$(git -C "$SOURCE" status --porcelain)"
mkdir -p "$BUILD/src/bin" "$ROOT/env/riichienv-wheels"
cp "$CODE/bridge/src/lib.rs" "$BUILD/src/lib.rs"
cp "$CODE/bridge/src/bin/reference.rs" "$BUILD/src/bin/reference.rs"
cp "$CODE/bridge/Cargo.lock" "$BUILD/Cargo.lock"
"$PY" - "$CODE/bridge/Cargo.toml" "$BUILD/Cargo.toml" "$SOURCE/native_bot" <<'PY'
import json, sys
from pathlib import Path
source, dest, native = sys.argv[1:]
text = Path(source).read_text().replace('path = "../.."', 'path = ' + json.dumps(native))
Path(dest).write_text(text)
PY
export PATH="$ROOT/env/rust/bin:$ROOT/env/riichienv-01/bin:$PATH"
export CARGO_HOME="$ROOT/env/cargo-home"
export CARGO_TARGET_DIR="$ROOT/env/akagi-bridge-target"
export CARGO_BUILD_JOBS=8
cd "$BUILD"
maturin build --release --locked -i "$PY" --out "$ROOT/env/riichienv-wheels"
cargo build --release --locked --bin reference
"$PY" -m pip install --no-deps --force-reinstall "$ROOT"/env/riichienv-wheels/akagi_rl_bridge-0.1.0-*.whl
"$PY" -m pip check
sha256sum "$SOURCE"/native_bot/src/{obs,adapt,action_codec,mjai_compat,chankan,tiles}.rs > "$BUILD/../original-source.sha256"
"$PY" -m pip freeze > "$BUILD/../requirements.freeze.txt"
