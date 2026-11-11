"""Transparent planning estimates from the ten-game benchmark (not a load test)."""
import argparse
import json
from pathlib import Path
import statistics


def estimate(data):
    games = data["games"]
    if len(games) != 10:
        raise ValueError("Expected ten completed games")
    decisions = sum(game["decisions"] for game in games)
    mean_decisions = decisions / len(games)
    non_inference_cpu = data["games_cpu_seconds"] - data["timing_components"]["inference_e2e_cpu_seconds"]
    cpu_per_decision = non_inference_cpu / decisions
    calibrated = {row["batch"]: row for row in data["microbatches"]}
    gib = 1024 ** 3
    worker_uss = data["worker_probe"]["four_tables"]["uss"] / gib
    worker_rss = data["worker_probe"]["four_tables"]["rss"] / gib
    broker_uss = data["games_memory"]["uss"] / gib
    broker_rss = data["games_memory"]["rss"] / gib
    memory_total = data["memory_before"]["total"] / gib
    memory_background = data["memory_before"]["used"] / gib
    scenarios = []
    # Efficiency and startup margins are explicitly UNMEASURED planning inputs.
    for workers, tables, batch, startup in ((4, 16, 16, (10, 20)),
                                           (8, 32, 16, (15, 30)),
                                           (16, 64, 64, (20, 40))):
        cpu_ceiling = workers / cpu_per_decision
        gpu_ceiling = calibrated[batch]["decisions_per_second"]
        ceiling = min(cpu_ceiling, gpu_ceiling)
        throughput = [ceiling * .25, ceiling * .50]
        runtime = [1000 * mean_decisions / throughput[1], 1000 * mean_decisions / throughput[0]]
        memory_range = [broker_uss + workers * worker_uss + .25,
                        broker_rss + workers * worker_rss + 1.0]
        micro_gpu = data["resources"][f"batch_{batch}"]["gpu"]["gpu_util_pct"]["mean"]
        gpu_duty_proxy = [rate / gpu_ceiling * micro_gpu for rate in throughput]
        scenarios.append({"workers": workers, "tables": tables, "inference_batch": batch,
                          "cpu_capacity_upper_decisions_per_second": cpu_ceiling,
                          "measured_inference_capacity_decisions_per_second": gpu_ceiling,
                          "unmeasured_system_efficiency_assumption": [.25, .50],
                          "estimated_decisions_per_second": throughput,
                          "estimated_1000_game_steady_seconds": runtime,
                          "unmeasured_startup_allowance_seconds": startup,
                          "estimated_1000_game_total_seconds": [runtime[0] + startup[0], runtime[1] + startup[1]],
                          "estimated_job_memory_gib": memory_range,
                          "estimated_host_memory_pct_including_background": [(memory_background + value) / memory_total * 100 for value in memory_range],
                          "cpu_host_pct_budget_from_quarter_workers_to_workers_plus_two":
                              [workers * .25 / data["logical_cpus"] * 100, (workers + 2) / data["logical_cpus"] * 100],
                          "full_batch_gpu_duty_proxy_pct_not_validated_utilization": gpu_duty_proxy})
    return {"measured_games": len(games), "measured_decisions": decisions,
            "measured_seconds": data["games_wall_seconds"],
            "seconds_per_game": data["games_wall_seconds"] / len(games),
            "per_game_min_max_seconds": [min(g["seconds"] for g in games), max(g["seconds"] for g in games)],
            "per_game_sample_std_seconds": statistics.stdev(g["seconds"] for g in games),
            "decisions_per_game": mean_decisions,
            "single_table_1000_seconds_linear_estimate": data["games_wall_seconds"] * 100,
            "cpu_seconds_per_decision_excluding_inference": cpu_per_decision,
            "measured_process_core_equivalents": data["games_cpu_seconds"] / data["games_wall_seconds"],
            "scenarios": scenarios,
            "limitations": ["Only ten frozen-policy hanchan; game lengths and future policies can differ",
                            "Concurrent workers, IPC and batch assembly were NOT benchmarked",
                            "25%-50% efficiency and startup budgets are planning assumptions, not confidence intervals",
                            "All workers must remain CPU-only; one shared GPU inference broker",
                            "GPU duty proxy assumes full batches; real GPU utilization may differ substantially",
                            "Memory bounds use worker USS/RSS plus queue allowance; actual sharing and allocator behavior differ",
                            "No PPO optimizer, rollout buffers, backpropagation, evaluation overhead or checkpointing included"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("benchmark", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--stage3", type=Path)
    args = parser.parse_args()
    data = json.loads(args.benchmark.read_text(encoding="utf-8"))
    result = estimate(data)
    if args.stage3:
        reference = json.loads(args.stage3.read_text(encoding="utf-8"))
        prior = {game["seed"]: game for game in reference["games"] if game["mode"] == "greedy_01"}
        for game in data["games"]:
            for key in ("scores", "ranks", "steps", "rewards"):
                if game[key] != prior[game["seed"]][key]:
                    raise AssertionError(f"Benchmark behavior changed: {game['seed']} {key}")
        result["same_seed_scores_ranks_steps_rewards_match_stage3"] = True
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
