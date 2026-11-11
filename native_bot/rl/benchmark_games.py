"""Ten greedy 01 hanchan, resource samples, and bounded inference calibration.

Calibration uses cached public observations, not extra complete games or PPO.
CPU is reported in core equivalents AND as a fraction of host logical CPUs.
"""
import time
ENTRY_TIME = time.perf_counter()

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

import numpy as np
import psutil
import torch
from riichienv import GameRule, RiichiEnv

from adapter import AkagiAdapter, FEATURE_CONTRACT, terminal_rewards
from model import FoldedPolicy, masked_logits


def memory():
    info = psutil.Process().memory_full_info()
    return {name: getattr(info, name) for name in ("rss", "uss", "pss")}


def probe_worker():
    torch.set_num_threads(1)
    before = memory()
    tables = []
    for seed in range(4):
        env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=seed)
        adapters = [AkagiAdapter(seat) for seat in range(4)]
        for pid, obs in env.reset().items():
            adapters[pid].prepare(obs)
        tables.append((env, adapters))
    print(json.dumps({"imported_modules": before, "four_tables": memory(),
                      "cuda_initialized": torch.cuda.is_initialized(),
                      "complete_games_run": 0}))


class Monitor:
    def __init__(self, uuid):
        self.phase = "startup"
        self.cpu = []
        self.gpu = []
        self.stop = threading.Event()
        self.process = psutil.Process()
        self.process.cpu_percent()
        psutil.cpu_percent()
        self.gpu_process = subprocess.Popen([
            "nvidia-smi", "--id=" + uuid,
            "--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,power.draw",
            "--format=csv,noheader,nounits", "--loop-ms=200",
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.threads = [threading.Thread(target=self._cpu, daemon=True),
                        threading.Thread(target=self._gpu, daemon=True)]
        for thread in self.threads:
            thread.start()

    def _cpu(self):
        while not self.stop.wait(.2):
            vm = psutil.virtual_memory()
            self.cpu.append({"t": time.perf_counter(), "phase": self.phase,
                             "process_cpu_pct_one_core": self.process.cpu_percent(),
                             "host_cpu_pct": psutil.cpu_percent(),
                             "process_rss_bytes": self.process.memory_info().rss,
                             "host_memory_used_bytes": vm.used, "host_memory_available_bytes": vm.available,
                             "host_memory_pct": vm.percent})

    def _gpu(self):
        for line in self.gpu_process.stdout:
            try:
                values = [float(part.strip()) for part in line.split(",")]
                self.gpu.append(dict(zip(
                    ["gpu_util_pct", "memory_controller_util_pct", "used_mib", "total_mib", "power_w"], values),
                    t=time.perf_counter(), phase=self.phase))
            except ValueError:
                continue

    def close(self):
        self.stop.set()
        self.gpu_process.terminate()  # only the nvidia-smi child started above
        self.gpu_process.wait(timeout=5)
        for thread in self.threads:
            thread.join(timeout=5)

    def summary(self, phase):
        result = {}
        for category, rows in (("cpu", self.cpu), ("gpu", self.gpu)):
            selected = [row for row in rows if row["phase"] == phase]
            data = {"samples": len(selected)}
            if selected:
                for key in selected[0]:
                    if key not in ("phase", "t"):
                        values = [row[key] for row in selected]
                        data[key] = {"mean": float(np.mean(values)), "max": max(values),
                                     "p95": float(np.percentile(values, 95))}
            result[category] = data
        return result


def infer(policy, observations, masks):
    x = torch.from_numpy(observations).cuda()
    legal = torch.from_numpy(masks).cuda()
    return masked_logits(policy(x), legal).argmax(1).cpu().tolist()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--games", type=int, default=10)
    parser.add_argument("--probe-worker", action="store_true")
    args = parser.parse_args()
    if args.probe_worker:
        probe_worker()
        return
    if args.games != 10 or args.weights is None or args.out is None:
        raise ValueError("This bounded benchmark requires exactly 10 games and weights/output")
    args.out.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.manual_seed(20261111)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    uuid = os.environ["CUDA_VISIBLE_DEVICES"]
    source_hash = hashlib.sha256(args.weights.read_bytes()).hexdigest()
    worker_probe = json.loads(subprocess.check_output(
        [sys.executable, __file__, "--probe-worker"], text=True))
    baseline_memory = psutil.virtual_memory()._asdict()
    monitor = Monitor(uuid)
    result = {"feature_contract": FEATURE_CONTRACT, "source_weights_sha256": source_hash,
              "logical_cpus": psutil.cpu_count(), "physical_cores": psutil.cpu_count(logical=False),
              "affinity_cpus": len(os.sched_getaffinity(0)), "gpu_uuid": uuid,
              "torch_threads": 1, "memory_before": baseline_memory, "worker_probe": worker_probe,
              "sampling_interval_seconds": .2, "policy": "four frozen greedy 01 policies, shared GPU model",
              "game_mode": "4p-red-half", "rules": "default_tenhou", "games": [], "microbatches": []}
    cached = []
    totals = defaultdict(float)
    batches = defaultdict(int)
    try:
        model_start = time.perf_counter()
        policy = FoldedPolicy.from_safetensors(args.weights).cuda().eval()
        with torch.inference_mode():
            for batch in (1, 2, 3, 4):
                for _ in range(20):
                    infer(policy, np.zeros((batch, 39, 34), np.float32), np.ones((batch, 82), np.bool_))
        result["model_load_and_warmup_seconds"] = time.perf_counter() - model_start
        result["startup_including_import_and_worker_probe_seconds"] = time.perf_counter() - ENTRY_TIME
        monitor.phase = "games"
        run_start = time.perf_counter()
        run_cpu = time.process_time()
        with torch.inference_mode():
            for game in range(10):
                seed = 2026111100 + 2 * game  # same ten greedy seeds as stage-3 integration
                started = time.perf_counter()
                cpu_started = time.process_time()
                env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=seed)
                adapters = [AkagiAdapter(seat) for seat in range(4)]
                obs = env.reset()
                totals["reset_wall_seconds"] += time.perf_counter() - started
                steps = decisions = 0
                while not env.done():
                    if not obs or steps >= 100000:
                        raise RuntimeError(f"Game stalled: seed={seed}, steps={steps}")
                    begin = time.perf_counter()
                    begin_cpu = time.process_time()
                    seats = list(obs)
                    prepared = [adapters[seat].prepare(obs[seat]) for seat in seats]
                    x = np.stack([decision.features for decision in prepared])
                    masks = np.stack([decision.legal_mask for decision in prepared])
                    totals["encode_wall_seconds"] += time.perf_counter() - begin
                    totals["encode_cpu_seconds"] += time.process_time() - begin_cpu
                    if len(cached) < 256:
                        cached.extend((decision.features.copy(), decision.legal_mask.copy()) for decision in prepared)
                    begin = time.perf_counter()
                    begin_cpu = time.process_time()
                    chosen = infer(policy, x, masks)
                    totals["inference_e2e_wall_seconds"] += time.perf_counter() - begin
                    totals["inference_e2e_cpu_seconds"] += time.process_time() - begin_cpu
                    begin = time.perf_counter()
                    begin_cpu = time.process_time()
                    actions = {seat: decision.resolve(aid) for seat, decision, aid in zip(seats, prepared, chosen)}
                    obs = env.step(actions)
                    totals["resolve_and_env_step_wall_seconds"] += time.perf_counter() - begin
                    totals["resolve_and_env_step_cpu_seconds"] += time.process_time() - begin_cpu
                    batches[len(seats)] += 1
                    decisions += len(seats)
                    steps += 1
                duration = time.perf_counter() - started
                entry = {"seed": seed, "seconds": duration, "cpu_seconds": time.process_time() - cpu_started,
                         "steps": steps, "decisions": decisions, "scores": list(env.scores()),
                         "ranks": list(env.ranks()), "rewards": terminal_rewards(list(env.ranks())).tolist()}
                result["games"].append(entry)
                print(f"game {game+1}/10: {duration:.3f}s, {decisions} decisions, scores={entry['scores']}", flush=True)
        result["games_wall_seconds"] = time.perf_counter() - run_start
        result["games_cpu_seconds"] = time.process_time() - run_cpu
        monitor.phase = "after_games"
        result["games_memory"] = memory()
        result["torch_gpu_allocated_bytes"] = torch.cuda.memory_allocated()
        result["torch_gpu_reserved_bytes"] = torch.cuda.memory_reserved()
        result["torch_gpu_peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
        result["timing_components"] = dict(totals)
        result["decision_batch_histogram"] = dict(batches)
        # Continuous calibrated input pipeline, 3 s per batch size, no extra games.
        with torch.inference_mode():
            for batch in (1, 4, 16, 64, 256):
                x = np.stack([cached[i % len(cached)][0] for i in range(batch)])
                mask = np.stack([cached[i % len(cached)][1] for i in range(batch)])
                for _ in range(20):
                    infer(policy, x, mask)
                monitor.phase = f"batch_{batch}"
                begin = time.perf_counter()
                begin_cpu = time.process_time()
                loops = 0
                while time.perf_counter() - begin < 3:
                    infer(policy, x, mask)
                    loops += 1
                elapsed = time.perf_counter() - begin
                result["microbatches"].append({"batch": batch, "iterations": loops,
                    "seconds": elapsed, "cpu_seconds": time.process_time() - begin_cpu,
                    "decisions_per_second": loops * batch / elapsed,
                    "seconds_per_batch": elapsed / loops, "memory": memory(),
                    "gpu_allocated_bytes": torch.cuda.memory_allocated(),
                    "gpu_reserved_bytes": torch.cuda.memory_reserved()})
        monitor.phase = "finished"
    finally:
        monitor.close()
        (args.out / "resource-samples.json").write_text(json.dumps({"cpu": monitor.cpu, "gpu": monitor.gpu}), encoding="utf-8")
    result["resources"] = {phase: monitor.summary(phase) for phase in ("games", "batch_1", "batch_4", "batch_16", "batch_64", "batch_256")}
    if hashlib.sha256(args.weights.read_bytes()).hexdigest() != source_hash:
        raise AssertionError("Original weights changed")
    result["total_job_seconds_including_calibration"] = time.perf_counter() - ENTRY_TIME
    (args.out / "benchmark.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"games_wall_seconds": result["games_wall_seconds"],
                      "games_cpu_seconds": result["games_cpu_seconds"],
                      "timing_components": result["timing_components"],
                      "games_resources": result["resources"]["games"],
                      "batch_decisions_per_second": {row["batch"]: row["decisions_per_second"] for row in result["microbatches"]}}, indent=2))


if __name__ == "__main__":
    main()
