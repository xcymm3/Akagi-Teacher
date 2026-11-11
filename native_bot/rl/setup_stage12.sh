#!/usr/bin/env bash
# Install only the simulator and model-validation dependencies; no PPO job.
set -euo pipefail
ROOT=${AKAGI_ROOT:-/disk2/Akagi}
ENV="$ROOT/env/riichienv-01"
OUT="$ROOT/experiments/riichienv-01/stage12"
mkdir -p "$OUT" "$ROOT/env/riichienv-wheels"
test "$(git -C "$ROOT/RiichiEnv" rev-parse HEAD)" = 0ee1236a283b15508f3ac28407027f340b81e1de
test -z "$(git -C "$ROOT/RiichiEnv" status --porcelain)"
if [[ ${1:-} != --resume ]]; then
    test ! -e "$ENV" || { echo "Refusing to replace existing environment: $ENV"; exit 1; }
    /usr/bin/python3 -m pip --python "$ROOT/env/py312-cu128/bin/python" freeze > "$OUT/original-environment.before.txt"
    sha256sum "$ROOT/experiments/runs/01-original-6m/akagi4p.safetensors" "$ROOT/source/native_bot/weights/akagi4p.safetensors" > "$OUT/original-weights.before.sha256"
    /usr/bin/python3 -m venv --without-pip "$ENV"
fi
test -f "$OUT/original-environment.before.txt"
test -f "$OUT/original-weights.before.sha256"
test -f "$ENV/pyvenv.cfg"
export PIP_CACHE_DIR="$ROOT/env/pip-cache"
export PIP_DEFAULT_TIMEOUT=120
export TMPDIR="$ROOT/env/tmp"
export PATH="$ROOT/env/rust/bin:$ENV/bin:$PATH"
export CARGO_HOME="$ROOT/env/cargo-home"
export CARGO_TARGET_DIR="$ROOT/env/riichienv-cargo-target"
export CARGO_BUILD_JOBS=8
# This host lacks ensurepip; bootstrap pip from a wheel without sudo.
if ! "$ENV/bin/python" -m pip --version >/dev/null 2>&1; then
    /usr/bin/python3 -m pip download --no-deps --dest "$ROOT/env/riichienv-wheels" 'pip==25.3'
    PIP_WHEEL="$ROOT/env/riichienv-wheels/pip-25.3-py3-none-any.whl"
    PYTHONPATH="$PIP_WHEEL" "$ENV/bin/python" -m pip install --no-index --no-deps --ignore-installed "$PIP_WHEEL"
fi
"$ENV/bin/python" -m pip install --no-index --find-links "$ROOT/env/wheelhouse" 'torch==2.10.0+cu128' 'numpy==2.2.6' 'safetensors==0.6.2' 'packaging==25.0'
"$ENV/bin/python" -m pip install 'maturin>=1.9.4,<2.0'
cd "$ROOT/RiichiEnv"
maturin build --release --locked -i "$ENV/bin/python" --out "$ROOT/env/riichienv-wheels"
"$ENV/bin/python" -m pip install "$ROOT"/env/riichienv-wheels/riichienv-0.4.11-*.whl
"$ENV/bin/python" -m pip check
"$ENV/bin/python" -m pip freeze > "$OUT/requirements.freeze.txt"
/usr/bin/python3 -m pip --python "$ROOT/env/py312-cu128/bin/python" freeze > "$OUT/original-environment.after.txt"
cmp "$OUT/original-environment.before.txt" "$OUT/original-environment.after.txt"
sha256sum --check "$OUT/original-weights.before.sha256"
rustc --version > "$OUT/rust-version.txt"
git rev-parse HEAD > "$OUT/riichienv-commit.txt"
echo 'STAGE1_INSTALL_OK'
