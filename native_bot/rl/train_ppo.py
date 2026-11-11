"""One-hour bounded PPO trial with fixed opponents and disjoint evaluation seeds."""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import time
import traceback

import numpy as np
import torch

from model import ActorCritic, FoldedPolicy
from ppo_core import PPOConfig, checkpoint, make_optimizer, parameter_hash, update
from ppo_rollout import RolloutPool
from run_parallel import TreeMonitor
from run_stability import configure


def evaluation_jobs(seed_start, seeds):
    return [{"id": i, "seed": seed_start+i//4, "seat": i%4} for i in range(seeds*4)]


def evaluate(pool, model, reference, config, seed_start, seeds, out):
    _, games, timing = pool.collect(model, reference, evaluation_jobs(seed_start, seeds), config, training=False)
    ranks = [g["ranks"][g["learner_seat"]] for g in games]
    rewards = [g["rewards"][g["learner_seat"]] for g in games]
    scores = [g["scores"][g["learner_seat"]] for g in games]
    result = {"seed_start": seed_start, "seeds": seeds, "games_count": len(games),
              "mean_rank": float(np.mean(ranks)), "mean_reward": float(np.mean(rewards)),
              "mean_score": float(np.mean(scores)), "fourth_rate": ranks.count(4)/len(games),
              "rank_counts": [ranks.count(rank) for rank in range(1, 5)],
              "seconds": timing["seconds"], "games": games}
    out.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    return result


def paired_evaluation(candidate, baseline):
    if candidate["seed_start"] != baseline["seed_start"] or candidate["seeds"] != baseline["seeds"]:
        raise ValueError("Evaluation seeds must match")
    groups = {}
    prior = {(g["seed"], g["learner_seat"]): g for g in baseline["games"]}
    for g in candidate["games"]:
        seat = g["learner_seat"]
        b = prior[g["seed"], seat]
        groups.setdefault(g["seed"], []).append([
            g["rewards"][seat]-b["rewards"][seat], g["ranks"][seat]-b["ranks"][seat],
            float(g["ranks"][seat] == 4)-float(b["ranks"][seat] == 4)])
    if any(len(group) != 4 for group in groups.values()):
        raise ValueError("Each evaluation seed must rotate all four learner seats")
    values = np.asarray([np.mean(group, axis=0) for group in groups.values()])
    rng = np.random.default_rng(20261111)
    draws = values[rng.integers(len(values), size=(5000, len(values)))].mean(axis=1)
    return {"bootstrap_unit": "seed cluster containing all four seat rotations", "bootstrap_replicates": 5000,
            "mean_deltas_reward_rank_fourth": values.mean(axis=0).tolist(),
            "paired_95pct_ci_reward_rank_fourth": np.percentile(draws, [2.5, 97.5], axis=0).T.tolist()}


def compact_eval(result):
    return {k: v for k, v in result.items() if k != "games"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=3600)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--tables-per-worker", type=int, default=4)
    parser.add_argument("--games-per-rollout", type=int, default=128)
    parser.add_argument("--eval-seeds", type=int, default=100)
    parser.add_argument("--holdout-seeds", type=int, default=200)
    parser.add_argument("--eval-every", type=float, default=600)
    args = parser.parse_args()
    if min(args.seconds, args.workers, args.tables_per_worker, args.games_per_rollout, args.eval_seeds,
           args.holdout_seeds, args.eval_every) <= 0:
        raise ValueError("Positive run settings required")
    args.out.mkdir(parents=True, exist_ok=False)
    configure()
    torch.backends.cudnn.deterministic = True
    config = PPOConfig()
    rng = np.random.default_rng(20261111)
    weight_hash = hashlib.sha256(args.weights.read_bytes()).hexdigest()
    model = ActorCritic(FoldedPolicy.from_safetensors(args.weights)).cuda().eval()
    reference = FoldedPolicy.from_safetensors(args.weights).cuda().eval().requires_grad_(False)
    reference_hash = parameter_hash(reference)
    optimizer = make_optimizer(model, config)
    import os
    monitor = TreeMonitor(os.environ["CUDA_VISIBLE_DEVICES"])
    pool = None
    manifest = {"config": asdict(config), "settings": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
                "source_weights_sha256": weight_hash, "train_seed_start": 310000000,
                "tuning_seed_start": 410000000, "holdout_seed_start": 510000000,
                "opponents": "three frozen greedy 01", "learner_sampling": "masked categorical, temperature 1",
                "evaluation": "greedy learner, four seat rotations per seed", "warmup_rollouts": 3,
                "torch": torch.__version__, "gpu": torch.cuda.get_device_name(), "rank_rewards": [2, 1, 0, -3]}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    started_all = time.perf_counter()
    try:
        pool = RolloutPool(args.workers, args.tables_per_worker)
        monitor.phase = "baseline_eval"
        baseline = evaluate(pool, model, reference, config, 410000000, args.eval_seeds, args.out/"tuning-baseline.json")
        model.policy.export(args.out/"initial-policy.safetensors")
        checkpoint(args.out/"initial.pt", model, optimizer, config, rng, {"iteration": 0, "next_game": 0})
        best_reward, best_path = baseline["mean_reward"], args.out/"initial.pt"
        evaluations = [{"iteration": 0, **compact_eval(baseline)}]
        iteration = game_count = transition_count = environment_decisions = 0
        rollout_seconds = update_seconds = 0.
        start = time.perf_counter()
        next_eval = args.eval_every
        with (args.out/"metrics.jsonl").open("w") as metrics, (args.out/"training-games.jsonl").open("w") as game_stream:
            while time.perf_counter()-start < args.seconds:
                monitor.phase = "rollout"
                jobs = [{"id": game_count+i, "seed": 310000000+game_count+i,
                         "seat": (game_count+i+iteration)%4} for i in range(args.games_per_rollout)]
                batch, games, timing = pool.collect(model, reference, jobs, config, training=True)
                rollout_seconds += timing["seconds"]
                game_count += len(games)
                transition_count += len(batch["actions"])
                environment_decisions += timing["environment_decisions"]
                monitor.phase = "warmup" if iteration < 3 else "update"
                before_policy = parameter_hash(model.policy) if iteration < 3 else None
                tick = time.perf_counter()
                losses = update(model, reference, optimizer, batch, config, rng, warmup=iteration < 3)
                update_elapsed = time.perf_counter()-tick
                update_seconds += update_elapsed
                if before_policy and before_policy != parameter_hash(model.policy):
                    raise AssertionError("Value warmup modified the actor")
                iteration += 1
                rewards = [g["terminal_reward"] for g in games]
                record = {"iteration": iteration, "elapsed_seconds": time.perf_counter()-start,
                          "games_total": game_count, "learner_transitions_total": transition_count,
                          "environment_decisions_total": environment_decisions,
                          "rollout_seconds": timing["seconds"], "update_seconds": update_elapsed,
                          "rollout_games_per_second": len(games)/timing["seconds"],
                          "training_reward_mean": float(np.mean(rewards)),
                          "training_rank_mean": float(np.mean([g["ranks"][g["learner_seat"]] for g in games])),
                          "seats": [sum(g["learner_seat"] == seat for g in games) for seat in range(4)],
                          "min_rounds_seen": min(g["rounds_seen"] for g in games), **losses}
                metrics.write(json.dumps(record) + "\n"); metrics.flush()
                for game in games:
                    game_stream.write(json.dumps(dict(game, iteration=iteration)) + "\n")
                game_stream.flush()
                print(json.dumps(record), flush=True)
                del batch
                if time.perf_counter()-start >= next_eval and time.perf_counter()-start < args.seconds:
                    monitor.phase = "periodic_eval"
                    path = args.out/f"checkpoint-{iteration:05d}.pt"
                    checkpoint(path, model, optimizer, config, rng, {"iteration": iteration, "next_game": game_count})
                    evaluation = evaluate(pool, model, reference, config, 410000000, args.eval_seeds,
                                          args.out/f"tuning-{iteration:05d}.json")
                    evaluations.append({"iteration": iteration, **compact_eval(evaluation)})
                    if evaluation["mean_reward"] > best_reward:
                        best_reward, best_path = evaluation["mean_reward"], path
                    (args.out/"evaluations.json").write_text(json.dumps(evaluations, indent=2))
                    print(json.dumps({"evaluation": evaluations[-1]}), flush=True)
                    next_eval += args.eval_every
        training_elapsed = time.perf_counter()-start
        checkpoint(args.out/"final.pt", model, optimizer, config, rng, {"iteration": iteration, "next_game": game_count})
        model.policy.export(args.out/"final-policy.safetensors")
        # Exported policy must be identical to the in-memory actor.
        exported = FoldedPolicy.from_safetensors(args.out/"final-policy.safetensors")
        if parameter_hash(exported) != parameter_hash(model.policy):
            raise AssertionError("Export changed actor tensors")
        del exported
        monitor.phase = "final_eval"
        tuning_final = evaluate(pool, model, reference, config, 410000000, args.eval_seeds, args.out/"tuning-final.json")
        evaluations.append({"iteration": iteration, "final": True, **compact_eval(tuning_final)})
        if tuning_final["mean_reward"] > best_reward:
            best_reward, best_path = tuning_final["mean_reward"], args.out/"final.pt"
        baseline_model = ActorCritic(FoldedPolicy.from_safetensors(args.weights)).cuda().eval()
        holdout_baseline = evaluate(pool, baseline_model, reference, config, 510000000, args.holdout_seeds, args.out/"holdout-baseline.json")
        del baseline_model
        holdout_final = evaluate(pool, model, reference, config, 510000000, args.holdout_seeds, args.out/"holdout-final.json")
        best_state = torch.load(best_path, map_location="cuda", weights_only=False)
        model.load_state_dict(best_state["model"])
        model.policy.export(args.out/"best-policy.safetensors")
        del best_state
        if best_path == args.out/"final.pt":
            holdout_best = holdout_final
        elif best_path == args.out/"initial.pt":
            holdout_best = holdout_baseline
        else:
            holdout_best = evaluate(pool, model, reference, config, 510000000, args.holdout_seeds, args.out/"holdout-best.json")
        if parameter_hash(reference) != reference_hash or hashlib.sha256(args.weights.read_bytes()).hexdigest() != weight_hash:
            raise AssertionError("Frozen reference or original weights changed")
        report = {"completed": True, "training_wall_seconds": training_elapsed,
                  "total_job_seconds": time.perf_counter()-started_all, "iterations": iteration,
                  "games": game_count, "learner_transitions": transition_count, "environment_decisions": environment_decisions,
                  "rollout_seconds": rollout_seconds, "update_seconds": update_seconds,
                  "games_per_training_wall_second": game_count/training_elapsed,
                  "learner_transitions_per_training_wall_second": transition_count/training_elapsed,
                  "best_checkpoint": best_path.name, "best_tuning_reward": best_reward,
                  "tuning_evaluations": evaluations, "holdout_baseline": compact_eval(holdout_baseline),
                  "holdout_final": compact_eval(holdout_final), "holdout_best": compact_eval(holdout_best),
                  "final_paired": paired_evaluation(holdout_final, holdout_baseline),
                  "best_paired": paired_evaluation(holdout_best, holdout_baseline),
                  "resources": {phase: monitor.summary(phase) for phase in
                      ("rollout", "warmup", "update", "periodic_eval", "baseline_eval", "final_eval")},
                  "original_weights_unchanged": True, "frozen_opponent_unchanged": True}
        (args.out/"summary.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"completed": True, "training_seconds": training_elapsed,
                          "games": game_count, "final_reward": holdout_final["mean_reward"],
                          "best_checkpoint": best_path.name}), flush=True)
    except BaseException:
        (args.out/"failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        if pool is not None:
            pool.close()
        monitor.close()
        (args.out/"resource-samples.json").write_text(json.dumps({"cpu": monitor.cpu, "gpu": monitor.gpu}))


if __name__ == "__main__":
    main()
