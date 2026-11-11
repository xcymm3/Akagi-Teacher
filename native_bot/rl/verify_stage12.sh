#!/usr/bin/env bash
set -euo pipefail
ROOT=${AKAGI_ROOT:-/disk2/Akagi}
CODE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OUT="$ROOT/experiments/riichienv-01/stage12"
PY="$ROOT/env/riichienv-01/bin/python"
export CUDA_VISIBLE_DEVICES=GPU-b564ea51-9c60-4f6b-1936-0178ed6e2c58
export CUBLAS_WORKSPACE_CONFIG=:4096:8
export OMP_NUM_THREADS=4
export MKL_NUM_THREADS=4
test -f "$OUT/requirements.freeze.txt"
nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu --format=csv > "$OUT/gpu.before.csv"
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv > "$OUT/processes.before.csv"
"$PY" "$CODE/smoke_env.py" --games 10 --out "$OUT/environment-smoke.json"
"$PY" "$CODE/validate_model.py" \
    --weights "$ROOT/experiments/runs/01-original-6m/akagi4p.safetensors" \
    --validation-data "$ROOT/experiments/data/validation" \
    --reference "$ROOT/source/native_bot/train/parity_check.py" \
    --out "$OUT/model"
"$PY" -m pip check
/usr/bin/python3 -m pip --python "$ROOT/env/py312-cu128/bin/python" freeze > "$OUT/original-environment.after.txt"
cmp "$OUT/original-environment.before.txt" "$OUT/original-environment.after.txt"
sha256sum --check "$OUT/original-weights.before.sha256"
nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu --format=csv > "$OUT/gpu.after.csv"
echo 'STAGE12_VERIFICATION_OK'
