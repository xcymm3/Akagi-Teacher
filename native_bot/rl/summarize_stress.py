"""Summarize measured serial/parallel runs, keeping timings and CPU scope explicit."""
import argparse
import json
from pathlib import Path
import statistics


def summarize(path):
    data = json.loads(path.read_text())
    games = data["games"]
    elapsed = data["games_wall_seconds"]
    if data["completed"] != len(games) or len({g["seed"] for g in games}) != len(games):
        raise ValueError("Missing or duplicated games")
    for game in games:
        if sorted(game["ranks"]) != [1, 2, 3, 4]:
            raise ValueError("Invalid terminal ranks")
        if game["rewards"] != [[2, 1, 0, -3][r-1] for r in game["ranks"]]:
            raise ValueError("Invalid terminal rewards")
    is_parallel = "workers" in data
    cpu_seconds = (data["broker_cpu_seconds"] + sum(w["cpu_seconds"] for w in data["worker_stats"])) if is_parallel else data["games_cpu_seconds"]
    resources = data["resources"]
    result = {"file": path.name, "workers": data.get("workers", 0),
              "tables": data.get("workers", 1) * data.get("tables_per_worker", 1),
              "completed": len(games), "decisions": sum(g["decisions"] for g in games),
              "games_seconds": elapsed, "total_job_seconds": data["total_job_seconds"],
              "games_per_second": len(games) / elapsed,
              "cpu_core_equivalents": cpu_seconds / elapsed,
              "task_cpu_host_pct_112_logical": cpu_seconds / elapsed / 112 * 100,
              "host_cpu_pct": resources["cpu"]["host_cpu_pct"],
              "gpu_util_pct": resources["gpu"]["gpu_util_pct"],
              "vram_mib": resources["gpu"]["used_mib"],
              "host_memory_pct": resources["cpu"]["host_memory_pct"],
              "source_weights_sha256": data["source_weights_sha256"]}
    if is_parallel:
        hist = data["batch_histogram"]
        result.update(startup_seconds=data["startup_seconds"],
                      average_batch=sum(int(n)*count for n, count in hist.items())/sum(hist.values()),
                      reference_differences=len(data["reference_differences"]) if data["reference_differences"] is not None else None,
                      reference_action_trace_compared=data.get("reference_action_trace_compared"),
                      all_workers_cpu_only=all(not w["cuda_initialized"] for w in data["worker_stats"]),
                      task_end_uss_gib=(data["broker_memory"]["uss"] + sum(w["memory"]["uss"] for w in data["worker_stats"]))/1024**3,
                      task_peak_rss_sum_gib=resources["cpu"]["tree_rss_sum_bytes"]["max"]/1024**3)
    else:
        snapshots = data["memory_snapshots"]
        result.update(mean_game_seconds=statistics.mean(g["seconds"] for g in games),
                      min_game_seconds=min(g["seconds"] for g in games),
                      max_game_seconds=max(g["seconds"] for g in games),
                      rss_at_first_snapshot_gib=snapshots[0]["memory"]["rss"]/1024**3,
                      rss_at_last_snapshot_gib=snapshots[-1]["memory"]["rss"]/1024**3,
                      task_peak_rss_gib=resources["cpu"]["process_rss_bytes"]["max"]/1024**3)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = [summarize(path) for path in args.runs]
    serial = next(row for row in result if row["workers"] == 0)
    for row in result:
        row["speedup_vs_serial"] = serial["games_seconds"] / row["games_seconds"]
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
