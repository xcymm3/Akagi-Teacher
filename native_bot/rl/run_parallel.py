"""CPU-only spawned workers, four independent tables each, one GPU broker.

One request in flight per worker bounds memory. IDs are checked before actions
reach a table. Exceptions, dead workers and timeouts fail the entire run.
"""
import time
ENTRY_TIME = time.perf_counter()

import argparse
from collections import Counter
import hashlib
import json
import multiprocessing as mp
from multiprocessing.connection import wait
import os
from pathlib import Path
import traceback

import numpy as np
import psutil
import torch

from benchmark_games import Monitor, infer, memory
from run_stability import Table, configure, load_policy


def worker(connection, worker_id, seeds, tables_per_worker):
    # Spawn, never fork an initialized CUDA process. Importing torch does not
    # initialize CUDA; workers are also explicitly denied visible GPUs.
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    configure()
    try:
        connection.send({"kind": "ready", "worker": worker_id, "pid": os.getpid()})
        if connection.recv() != "start":
            raise RuntimeError("Missing start barrier")
        start_cpu = time.process_time()
        pending = iter(seeds)
        tables = {}
        completed = []
        sequence = 0
        while True:
            for slot in range(tables_per_worker):
                if slot not in tables:
                    seed = next(pending, None)
                    if seed is not None:
                        tables[slot] = Table(seed)
            if not tables:
                if torch.cuda.is_initialized():
                    raise AssertionError("CPU worker initialized CUDA")
                connection.send({"kind": "done", "worker": worker_id, "completed": completed,
                                 "cpu_seconds": time.process_time() - start_cpu,
                                 "memory": memory(), "cuda_initialized": False})
                break
            slots = sorted(tables)
            prepared = [tables[slot].prepare() for slot in slots]
            sizes = [len(item[0]) for item in prepared]
            connection.send({"kind": "infer", "worker": worker_id, "sequence": sequence,
                             "features": np.concatenate([p[0] for p in prepared]),
                             "masks": np.concatenate([p[1] for p in prepared]),
                             "completed": completed})
            completed = []
            response_sequence, actions = connection.recv()
            if response_sequence != sequence or len(actions) != sum(sizes):
                raise RuntimeError("Stale or misrouted inference response")
            offset = 0
            for slot, size in zip(slots, sizes):
                if tables[slot].advance(actions[offset:offset+size]):
                    completed.append(tables.pop(slot).result())
                offset += size
            sequence += 1
    except BaseException:
        try:
            connection.send({"kind": "error", "worker": worker_id, "traceback": traceback.format_exc()})
        except (BrokenPipeError, EOFError, OSError):
            pass
        raise
    finally:
        connection.close()


class TreeMonitor(Monitor):
    def _cpu(self):
        while not self.stop.wait(.2):
            vm = psutil.virtual_memory()
            children = self.process.children(recursive=True)
            rss = self.process.memory_info().rss
            for child in children:
                try:
                    rss += child.memory_info().rss
                except psutil.NoSuchProcess:
                    pass
            self.cpu.append({"t": time.perf_counter(), "phase": self.phase,
                             "broker_cpu_pct_one_core": self.process.cpu_percent(),
                             "host_cpu_pct": psutil.cpu_percent(), "tree_rss_sum_bytes": rss,
                             "host_memory_used_bytes": vm.used, "host_memory_pct": vm.percent,
                             "host_memory_available_bytes": vm.available})


def compare_reference(games, path):
    reference = json.loads(path.read_text())
    prior = {game["seed"]: game for game in reference["games"]}
    differences = []
    for game in games:
        for key in ("scores", "ranks", "steps", "decisions", "rewards", "action_sha256"):
            if key == "action_sha256" and game.get("action_trace_format") != prior[game["seed"]].get("action_trace_format"):
                continue  # explicitly reported below; never compare unlike hash formats
            if game[key] != prior[game["seed"]][key]:
                differences.append({"seed": game["seed"], "field": key,
                                    "serial": prior[game["seed"]][key], "parallel": game[key]})
    return differences


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--games", type=int, default=1000)
    parser.add_argument("--workers", type=int, required=True)
    parser.add_argument("--tables-per-worker", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026111100)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--verify-actions", action="store_true",
                        help="Diagnostic: compare every batched choice against singleton GPU inference")
    args = parser.parse_args()
    if min(args.games, args.workers, args.tables_per_worker, args.timeout) <= 0:
        raise ValueError("Counts and timeout must be positive")
    args.out.mkdir(parents=True, exist_ok=False)
    configure()
    weight_hash = hashlib.sha256(args.weights.read_bytes()).hexdigest()
    policy = load_policy(args.weights)
    context = mp.get_context("spawn")
    processes, connections = [], []
    monitor = TreeMonitor(os.environ["CUDA_VISIBLE_DEVICES"])
    results, worker_stats = [], []
    hist = Counter()
    expected_sequence = {i: 0 for i in range(args.workers)}
    verified = 0
    try:
        for wid in range(args.workers):
            parent, child = context.Pipe()
            seeds = [args.seed + 2 * i for i in range(wid, args.games, args.workers)]
            process = context.Process(target=worker, args=(child, wid, seeds, args.tables_per_worker))
            process.start()
            child.close()
            processes.append(process)
            connections.append(parent)
        waiting = set(connections)
        deadline = time.monotonic() + args.timeout
        while waiting:
            ready = wait(waiting, timeout=min(1, max(0, deadline - time.monotonic())))
            for conn in ready:
                message = conn.recv()
                if message["kind"] != "ready":
                    raise RuntimeError(f"Worker startup failed: {message}")
                waiting.remove(conn)
            if time.monotonic() >= deadline and waiting:
                raise TimeoutError("Worker startup timeout")
        startup = time.perf_counter() - ENTRY_TIME
        monitor.phase = "games"
        start, cpu_start = time.perf_counter(), time.process_time()
        last_seen = {conn: time.monotonic() for conn in connections}
        for conn in connections:
            conn.send("start")
        active = set(connections)
        last_print = 0
        with torch.inference_mode(), (args.out / "games.jsonl").open("w") as stream:
            while active:
                ready = wait(active, timeout=1)
                requests = []
                for conn in ready:
                    msg = conn.recv()
                    last_seen[conn] = time.monotonic()
                    wid = connections.index(conn)
                    if msg["worker"] != wid:
                        raise RuntimeError("Worker identity mismatch")
                    for game in msg.get("completed", []):
                        results.append(game)
                        stream.write(json.dumps(game) + "\n")
                    if msg["kind"] == "infer":
                        if msg["sequence"] != expected_sequence[wid]:
                            raise RuntimeError("Duplicate or out of order request")
                        expected_sequence[wid] += 1
                        requests.append((conn, msg))
                    elif msg["kind"] == "done":
                        worker_stats.append({k: v for k, v in msg.items() if k != "completed"})
                        active.remove(conn)
                    else:
                        raise RuntimeError(f"Worker failure: {msg}")
                if requests:
                    x = np.concatenate([msg["features"] for _, msg in requests])
                    masks = np.concatenate([msg["masks"] for _, msg in requests])
                    chosen = infer(policy, x, masks)
                    if args.verify_actions:
                        singles = [infer(policy, x[i:i+1], masks[i:i+1])[0] for i in range(len(x))]
                        if singles != chosen:
                            raise AssertionError("Batched decisions differ from singleton decisions")
                        verified += len(x)
                    hist[len(x)] += 1
                    offset = 0
                    for conn, msg in requests:
                        size = len(msg["features"])
                        conn.send((msg["sequence"], chosen[offset:offset+size]))
                        offset += size
                for conn in active:
                    if time.monotonic() - last_seen[conn] > args.timeout:
                        raise TimeoutError(f"Worker {connections.index(conn)} stalled")
                if len(results) - last_print >= 25 or len(results) == args.games:
                    stream.flush()
                    print(f"completed={len(results)}/{args.games} elapsed={time.perf_counter()-start:.3f}s", flush=True)
                    last_print = len(results)
        elapsed, broker_cpu = time.perf_counter() - start, time.process_time() - cpu_start
        monitor.phase = "finished"
        for process in processes:
            process.join(timeout=10)
            if process.exitcode != 0:
                raise RuntimeError(f"Worker exit={process.exitcode}")
        if len(results) != args.games or {g["seed"] for g in results} != {args.seed+2*i for i in range(args.games)}:
            raise AssertionError("Missing or duplicated completed games")
        differences = compare_reference(results, args.reference) if args.reference else None
        trace_comparable = None
        if args.reference:
            prior = {g["seed"]: g for g in json.loads(args.reference.read_text())["games"]}
            trace_comparable = all(g.get("action_trace_format") == prior[g["seed"]].get("action_trace_format") for g in results)
        if hashlib.sha256(args.weights.read_bytes()).hexdigest() != weight_hash:
            raise AssertionError("Source weights changed")
        report = {"completed": len(results), "workers": args.workers, "tables_per_worker": args.tables_per_worker,
                  "games_wall_seconds": elapsed, "startup_seconds": startup,
                  "total_job_seconds": time.perf_counter() - ENTRY_TIME,
                  "broker_cpu_seconds": broker_cpu, "worker_stats": worker_stats,
                  "batch_histogram": dict(hist), "verified_singleton_decisions": verified,
                  "source_weights_sha256": weight_hash, "reference_differences": differences,
                  "reference_action_trace_compared": trace_comparable,
                  "resources": monitor.summary("games"), "broker_memory": memory(),
                  "games": sorted(results, key=lambda g: g["seed"])}
        (args.out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: report[k] for k in ("completed", "games_wall_seconds", "startup_seconds", "total_job_seconds")}), flush=True)
        if differences:
            raise AssertionError(f"Serial behavior differs: {len(differences)} fields; see summary.json")
    except BaseException:
        (args.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        for conn in connections:
            conn.close()
        for process in processes:
            if process.is_alive():
                process.terminate()  # only workers owned by this run
            process.join(timeout=5)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
        monitor.close()
        (args.out / "resource-samples.json").write_text(json.dumps({"cpu": monitor.cpu, "gpu": monitor.gpu}))


if __name__ == "__main__":
    main()
