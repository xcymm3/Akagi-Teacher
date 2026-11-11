"""Persistent CPU-only tables with a single learner/frozen-opponent GPU broker."""
from collections import Counter
import multiprocessing as mp
from multiprocessing.connection import wait
import os
import time
import traceback

import numpy as np
import torch

from benchmark_games import memory
from ppo_core import log_distribution, terminal_gae
from run_stability import Table, configure


def rollout_worker(connection, wid, table_count):
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    configure()
    try:
        connection.send({"kind": "ready", "worker": wid})
        while True:
            command = connection.recv()
            if command["kind"] == "stop":
                return
            if command["kind"] != "collect":
                raise RuntimeError("Invalid worker command")
            version = command["version"]
            jobs = iter(command["jobs"])
            tables, info = {}, {}
            completed = []
            sequence = 0
            cpu = time.process_time()
            while True:
                for slot in range(table_count):
                    if slot not in tables:
                        job = next(jobs, None)
                        if job is not None:
                            info[slot] = job
                            tables[slot] = Table(job["seed"])
                if not tables:
                    if torch.cuda.is_initialized():
                        raise AssertionError("Worker initialized CUDA")
                    connection.send({"kind": "done", "worker": wid, "version": version,
                                     "completed": completed, "cpu_seconds": time.process_time()-cpu,
                                     "cuda_initialized": False, "memory": memory()})
                    break
                slots = sorted(tables)
                prepared = [tables[slot].prepare() for slot in slots]
                sizes = [len(x) for x, _ in prepared]
                ids, learner = [], []
                for slot in slots:
                    ids.extend([info[slot]["id"]] * len(tables[slot].seats))
                    learner.extend(seat == info[slot]["seat"] for seat in tables[slot].seats)
                connection.send({"kind": "infer", "worker": wid, "version": version,
                                 "sequence": sequence, "completed": completed,
                                 "features": np.concatenate([x for x, _ in prepared]),
                                 "masks": np.concatenate([m for _, m in prepared]),
                                 "ids": ids, "learner": np.asarray(learner, dtype=np.bool_)})
                completed = []
                response_version, response_sequence, actions = connection.recv()
                if response_version != version or response_sequence != sequence or len(actions) != sum(sizes):
                    raise RuntimeError("Stale or misrouted rollout response")
                offset = 0
                for slot, size in zip(slots, sizes):
                    if tables[slot].advance(actions[offset:offset+size]):
                        table = tables.pop(slot)
                        result = table.result()
                        result.update(id=info[slot]["id"], learner_seat=info[slot]["seat"],
                                      rounds_seen=max(a.rounds_seen for a in table.adapters))
                        completed.append(result)
                    offset += size
                sequence += 1
    except BaseException:
        try:
            connection.send({"kind": "error", "worker": wid, "traceback": traceback.format_exc()})
        except (OSError, EOFError):
            pass
        raise
    finally:
        connection.close()


class RolloutPool:
    def __init__(self, workers=16, tables=4, timeout=120):
        self.workers, self.tables, self.timeout = workers, tables, timeout
        self.processes, self.connections = [], []
        self.version = 0
        context = mp.get_context("spawn")
        try:
            for wid in range(workers):
                parent, child = context.Pipe()
                process = context.Process(target=rollout_worker, args=(child, wid, tables))
                process.start()
                child.close()
                self.processes.append(process)
                self.connections.append(parent)
            pending = set(self.connections)
            deadline = time.monotonic() + timeout
            while pending:
                for conn in wait(pending, timeout=1):
                    msg = conn.recv()
                    if msg["kind"] != "ready" or msg["worker"] != self.connections.index(conn):
                        raise RuntimeError(f"Worker startup failed: {msg}")
                    pending.remove(conn)
                if pending and time.monotonic() > deadline:
                    raise TimeoutError("Worker startup timeout")
        except BaseException:
            self.close()
            raise

    def close(self):
        for conn in self.connections:
            try:
                conn.send({"kind": "stop"})
            except (OSError, EOFError):
                pass
            conn.close()
        for process in self.processes:
            process.join(timeout=2)
            if process.is_alive():
                process.terminate()
                process.join(timeout=2)
            if process.is_alive():
                process.kill()
                process.join(timeout=2)

    def collect(self, model, reference, jobs, config, training=True):
        if len({j["id"] for j in jobs}) != len(jobs) or not jobs:
            raise ValueError("Nonempty unique jobs required")
        if any(not 0 <= j["seat"] < 4 for j in jobs):
            raise ValueError("Invalid learner seat")
        model.eval()
        reference.eval()
        device = next(model.parameters()).device
        self.version += 1
        for wid, conn in enumerate(self.connections):
            conn.send({"kind": "collect", "version": self.version, "jobs": jobs[wid::self.workers]})
        active = set(self.connections)
        sequence = {conn: 0 for conn in active}
        last_seen = {conn: time.monotonic() for conn in active}
        trajectories = {job["id"]: [] for job in jobs} if training else None
        results, stats = [], []
        hist = Counter()
        start = time.perf_counter()
        with torch.inference_mode():
            while active:
                requests = []
                for conn in wait(active, timeout=1):
                    msg = conn.recv()
                    if msg["kind"] == "error":
                        raise RuntimeError(msg["traceback"])
                    if msg["worker"] != self.connections.index(conn) or msg["version"] != self.version:
                        raise RuntimeError("Wrong worker or policy version")
                    last_seen[conn] = time.monotonic()
                    results.extend(msg["completed"])
                    if msg["kind"] == "done":
                        active.remove(conn)
                        stats.append({k: v for k, v in msg.items() if k != "completed"})
                    elif msg["kind"] == "infer":
                        if msg["sequence"] != sequence[conn]:
                            raise RuntimeError("Out of order rollout request")
                        sequence[conn] += 1
                        requests.append((conn, msg))
                    else:
                        raise RuntimeError("Unknown rollout message")
                if requests:
                    x = np.concatenate([msg["features"] for _, msg in requests])
                    masks = np.concatenate([msg["masks"] for _, msg in requests])
                    learner = np.concatenate([msg["learner"] for _, msg in requests])
                    ids = [gid for _, msg in requests for gid in msg["ids"]]
                    chosen = np.empty(len(x), dtype=np.int64)
                    for is_learner in (False, True):
                        indices = np.flatnonzero(learner == is_learner)
                        if not len(indices):
                            continue
                        inputs = torch.from_numpy(x[indices]).to(device)
                        legal = torch.from_numpy(masks[indices]).to(device)
                        if is_learner:
                            logits, values = model(inputs)
                        else:
                            logits = reference(inputs)
                        logp = log_distribution(logits, legal)
                        actions = torch.multinomial(logp.exp(), 1).squeeze(1) if training and is_learner else logp.argmax(1)
                        action_cpu = actions.cpu().numpy()
                        chosen[indices] = action_cpu
                        if training and is_learner:
                            selected = logp.gather(1, actions[:, None]).squeeze(1).cpu().numpy()
                            value_cpu = values.cpu().numpy()
                            for k, index in enumerate(indices):
                                trajectories[ids[index]].append((x[index].copy(), masks[index].copy(),
                                    int(action_cpu[k]), float(selected[k]), float(value_cpu[k])))
                    hist[len(x)] += 1
                    offset = 0
                    for conn, msg in requests:
                        count = len(msg["features"])
                        conn.send((self.version, msg["sequence"], chosen[offset:offset+count].tolist()))
                        offset += count
                for conn in active:
                    if time.monotonic()-last_seen[conn] > self.timeout:
                        raise TimeoutError("Rollout worker stalled")
        if {r["id"] for r in results} != {j["id"] for j in jobs} or len(results) != len(jobs):
            raise AssertionError("Incomplete or duplicate trajectories")
        batch = None
        if training:
            records, advantages, returns = [], [], []
            for result in sorted(results, key=lambda r: r["id"]):
                trajectory = trajectories[result["id"]]
                reward = result["rewards"][result["learner_seat"]]
                adv, ret = terminal_gae([r[4] for r in trajectory], reward, config.gamma, config.gae_lambda)
                records.extend(trajectory)
                advantages.extend(adv)
                returns.extend(ret)
                result["learner_transitions"] = len(trajectory)
                result["terminal_reward"] = reward
            batch = {"features": np.stack([r[0] for r in records]), "masks": np.stack([r[1] for r in records]),
                     "actions": np.asarray([r[2] for r in records], dtype=np.int64),
                     "old_logp": np.asarray([r[3] for r in records], dtype=np.float32),
                     "old_values": np.asarray([r[4] for r in records], dtype=np.float32),
                     "advantages": np.asarray(advantages, dtype=np.float32),
                     "returns": np.asarray(returns, dtype=np.float32)}
        return batch, sorted(results, key=lambda r: r["id"]), {
            "seconds": time.perf_counter()-start, "batch_histogram": dict(hist), "workers": stats,
            "environment_decisions": sum(r["decisions"] for r in results)}
