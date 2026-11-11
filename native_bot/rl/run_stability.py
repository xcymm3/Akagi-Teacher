"""Frozen-policy stability runner; reusable table state for CPU workers."""
import time
ENTRY_TIME = time.perf_counter()

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import torch
from riichienv import GameRule, RiichiEnv

from adapter import AkagiAdapter, terminal_rewards
from benchmark_games import Monitor, infer, memory
from model import FoldedPolicy


class Table:
    def __init__(self, seed):
        self.seed = seed
        self.started = time.perf_counter()
        self.env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=seed)
        self.adapters = [AkagiAdapter(seat) for seat in range(4)]
        self.obs = self.env.reset()
        self.steps = self.decisions = 0
        self.digest = hashlib.sha256()

    def prepare(self):
        if not self.obs or self.steps >= 100000:
            raise RuntimeError(f"Stalled game seed={self.seed} steps={self.steps}")
        self.seats = list(self.obs)
        self.prepared = [self.adapters[seat].prepare(self.obs[seat]) for seat in self.seats]
        return (np.stack([d.features for d in self.prepared]),
                np.stack([d.legal_mask for d in self.prepared]))

    def advance(self, chosen):
        if len(chosen) != len(self.seats):
            raise ValueError("Response action count mismatch")
        actions = {seat: decision.resolve(aid) for seat, decision, aid in
                   zip(self.seats, self.prepared, chosen)}
        # Observation dictionaries may enumerate simultaneous seats differently
        # across processes. Hash semantic seat/action pairs in canonical order.
        self.digest.update(bytes([len(chosen)] + [v for pair in sorted(zip(self.seats, chosen)) for v in pair]))
        self.obs = self.env.step(actions)
        self.steps += 1
        self.decisions += len(chosen)
        return self.env.done()

    def result(self):
        if not self.env.done():
            raise RuntimeError("Incomplete game")
        ranks = list(self.env.ranks())
        return {"seed": self.seed, "steps": self.steps, "decisions": self.decisions,
                "scores": list(self.env.scores()), "ranks": ranks,
                "rewards": terminal_rewards(ranks).tolist(),
                "action_sha256": self.digest.hexdigest(), "action_trace_format": "sorted-seats-v1",
                "seconds": time.perf_counter() - self.started}


def configure():
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.manual_seed(20261111)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False


def load_policy(path):
    policy = FoldedPolicy.from_safetensors(path).cuda().eval()
    with torch.inference_mode():
        for _ in range(20):
            infer(policy, np.zeros((4, 39, 34), np.float32), np.ones((4, 82), np.bool_))
    return policy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--games", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=2026111100)
    args = parser.parse_args()
    if args.games < 1:
        raise ValueError("Positive game count required")
    args.out.mkdir(parents=True, exist_ok=False)
    configure()
    weight_hash = hashlib.sha256(args.weights.read_bytes()).hexdigest()
    policy = load_policy(args.weights)
    monitor = Monitor(os.environ["CUDA_VISIBLE_DEVICES"])
    results = []
    snapshots = []
    start, cpu = time.perf_counter(), time.process_time()
    monitor.phase = "games"
    try:
        with torch.inference_mode(), (args.out / "games.jsonl").open("w") as stream:
            for i in range(args.games):
                table = Table(args.seed + 2 * i)
                while True:
                    x, masks = table.prepare()
                    if table.advance(infer(policy, x, masks)):
                        break
                result = table.result()
                results.append(result)
                stream.write(json.dumps(result) + "\n")
                stream.flush()
                if (i + 1) % 25 == 0 or i + 1 == args.games:
                    snapshots.append({"completed": i + 1, "memory": memory()})
                    print(f"completed={i+1}/{args.games} elapsed={time.perf_counter()-start:.3f}s", flush=True)
        elapsed, cpu_elapsed = time.perf_counter() - start, time.process_time() - cpu
    except BaseException:
        import traceback
        (args.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        monitor.phase = "finished"
        monitor.close()
        (args.out / "resource-samples.json").write_text(json.dumps({"cpu": monitor.cpu, "gpu": monitor.gpu}))
    assert hashlib.sha256(args.weights.read_bytes()).hexdigest() == weight_hash
    report = {"completed": len(results), "games_wall_seconds": elapsed, "games_cpu_seconds": cpu_elapsed,
              "total_job_seconds": time.perf_counter()-ENTRY_TIME, "source_weights_sha256": weight_hash,
              "seed_start": args.seed, "seed_stride": 2, "resources": monitor.summary("games"),
              "memory_snapshots": snapshots, "games": results}
    (args.out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("completed", "games_wall_seconds", "total_job_seconds")}), flush=True)


if __name__ == "__main__":
    main()
