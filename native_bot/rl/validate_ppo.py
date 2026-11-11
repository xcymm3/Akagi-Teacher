"""Real-environment PPO validation before a budgeted training trial."""
import argparse
import json
from pathlib import Path
import time

import numpy as np
import torch

from model import ActorCritic, FoldedPolicy
from ppo_core import PPOConfig, checkpoint, log_distribution, make_optimizer, parameter_hash, restore, update
from ppo_rollout import RolloutPool
from run_stability import configure


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    configure()
    torch.backends.cudnn.deterministic = True
    config = PPOConfig()
    model = ActorCritic(FoldedPolicy.from_safetensors(args.weights)).cuda().eval()
    reference = FoldedPolicy.from_safetensors(args.weights).cuda().eval().requires_grad_(False)
    original = parameter_hash(reference)
    optimizer = make_optimizer(model, config)
    rng = np.random.default_rng(20261111)
    pool = RolloutPool(16, 4)
    start = time.perf_counter()
    try:
        jobs = [{"id": i, "seed": 610000000+i, "seat": i%4} for i in range(64)]
        batch, games, timing = pool.collect(model, reference, jobs, config)
        offset = 0
        for game in games:
            length = game["learner_transitions"]
            np.testing.assert_allclose(batch["returns"][offset:offset+length], game["terminal_reward"], atol=1e-5)
            offset += length
        assert offset == len(batch["actions"])
        assert all(not w["cuda_initialized"] for w in timing["workers"])
        assert all(any(g["learner_seat"] == seat for g in games) for seat in range(4))
        with torch.inference_mode():
            logits, _ = model(torch.from_numpy(batch["features"][:512]).cuda())
            logp = log_distribution(logits, torch.from_numpy(batch["masks"][:512]).cuda())
            selected = logp.gather(1, torch.from_numpy(batch["actions"][:512, None]).cuda()).squeeze(1).cpu().numpy()
        ratio_log_error = float(np.max(np.abs(selected-batch["old_logp"][:512])))
        assert ratio_log_error < 1e-3, ratio_log_error
        warmup = update(model, reference, optimizer, batch, config, rng, warmup=True)
        assert parameter_hash(model.policy) == original
        assert float(model.value_head.weight.abs().sum()) > 0
        # A fresh rollout must follow value updates: old values/log-probs are on-policy.
        del batch
        jobs = [{"id": i, "seed": 610001000+i, "seat": (i+1)%4} for i in range(64)]
        batch, second_games, timing2 = pool.collect(model, reference, jobs, config)
        checkpoint(args.out/"before-update.pt", model, optimizer, config, rng, {"next_game": 128})
        losses = update(model, reference, optimizer, batch, config, rng)
        expected = {k: v.detach().clone() for k, v in model.state_dict().items()}
        assert parameter_hash(model.policy) != original
        assert parameter_hash(reference) == original
        restored = restore(args.out/"before-update.pt", model, optimizer, rng)
        assert restored["metadata"]["next_game"] == 128
        repeated = update(model, reference, optimizer, batch, config, rng)
        difference = max(float((expected[k]-v).abs().max()) for k, v in model.state_dict().items())
        assert difference <= 1e-6, difference
        assert losses["minibatches"] == repeated["minibatches"]
        model.policy.export(args.out/"diagnostic-policy.safetensors")
        exported = FoldedPolicy.from_safetensors(args.out/"diagnostic-policy.safetensors").cuda()
        with torch.inference_mode():
            x = torch.from_numpy(batch["features"][:128]).cuda()
            export_diff = float((exported(x)-model.policy(x)).abs().max())
        assert export_diff == 0.
        report = {"passed": True, "seconds": time.perf_counter()-start, "workers": 16, "tables": 64,
                  "complete_games": len(games)+len(second_games), "first_rollout_transitions": offset,
                  "second_rollout_transitions": len(batch["actions"]),
                  "rank_reward_values_observed": sorted(set(g["terminal_reward"] for g in games+second_games)),
                  "rounds_seen_min_max": [min(g["rounds_seen"] for g in games+second_games), max(g["rounds_seen"] for g in games+second_games)],
                  "old_log_probability_max_error": ratio_log_error, "warmup": warmup, "ppo": losses,
                  "checkpoint_next_update_max_parameter_difference": difference,
                  "export_forward_max_difference": export_diff, "frozen_reference_unchanged": True,
                  "actor_unchanged_during_warmup": True, "actor_changed_during_ppo": True,
                  "terminal_rewards_propagated_entire_hanchan": True}
        (args.out/"summary.json").write_text(json.dumps(report, indent=2)+"\n")
        print(json.dumps(report, indent=2), flush=True)
    finally:
        pool.close()


if __name__ == "__main__":
    main()
