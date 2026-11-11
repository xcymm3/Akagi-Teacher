"""Bounded stage-3 integration: actual games + independent full-prefix Rust oracle."""
import argparse
from collections import Counter
import hashlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np
import torch
from riichienv import ActionType, GameRule, RiichiEnv

from adapter import AkagiAdapter, FEATURE_CONTRACT, RANK_REWARDS, terminal_rewards
from model import FoldedPolicy, masked_logits
from test_adapter import VisibleObservation


class Oracle:
    def __init__(self, binary):
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, encoding="utf-8", bufsize=1)

    def check(self, seat, adapter, decision, logits):
        query = {"seat": seat, "events": list(adapter.history),
                 "actions": json.loads(decision.legal_json), "logits": logits.tolist()}
        self.process.stdin.write(json.dumps(query, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        response = self.process.stdout.readline()
        if not response:
            raise RuntimeError(f"Reference oracle exited: {self.process.poll()}")
        result = json.loads(response)
        np.testing.assert_array_equal(decision.features, np.asarray(result["features"], np.float32).reshape(39, 34))
        np.testing.assert_array_equal(decision.legal_mask, result["mask"])
        restored = np.asarray(result["quantized"], np.float32) / np.float32(255) * np.float32(4)
        np.testing.assert_array_equal(decision.quantized_features().ravel(), restored)
        ids = sorted(decision.representatives, key=lambda action_id: (-logits[action_id], action_id))
        expected_indices = [decision.representatives[action_id] for action_id in ids]
        if expected_indices != [pair[0] for pair in result["ranked"]]:
            raise AssertionError("Physical action ranking differs from original Rust codec")
        legal_logits = torch.from_numpy(logits.copy()).masked_fill(~torch.from_numpy(decision.legal_mask.copy()), -torch.inf)
        probabilities = legal_logits.softmax(0).numpy()
        np.testing.assert_allclose([probabilities[i] for i in ids], [pair[1] for pair in result["ranked"]], atol=2e-6, rtol=2e-6)
        if result["replay_mask"] != result["mask"]:
            return {"query": query, "legacy_ids": np.flatnonzero(result["replay_mask"]).tolist(),
                    "environment_ids": np.flatnonzero(result["mask"]).tolist()}
        return None

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)


def public_planes(obs, features):
    """Independent visible-state checks, excluding documented legacy planes."""
    pid = obs.player_id
    expected_red = np.zeros(34, np.float32)
    for tid in obs.hand:
        if tid in (16, 52, 88):
            expected_red[tid // 4] = 1
    np.testing.assert_array_equal(features[4], expected_red)
    for relative in range(4):
        absolute = (pid + relative) % 4
        discarded = np.bincount(np.asarray(obs.discards[absolute], np.int64) // 4, minlength=34) / 4
        melds = [tile for meld in obs.melds[absolute] for tile in meld.tiles]
        meld_counts = np.bincount(np.asarray(melds, np.int64) // 4, minlength=34) / 4
        np.testing.assert_array_equal(features[9 + relative], discarded)
        np.testing.assert_array_equal(features[13 + relative], meld_counts)
        expected_score = np.clip(np.float32(obs.scores[absolute]) / np.float32(50000), 0, 4)
        np.testing.assert_array_equal(features[25 + relative], np.full(34, expected_score, np.float32))
        np.testing.assert_array_equal(features[17 + relative], np.full(34, obs.riichi_declared[absolute]))
    indicators = np.bincount(np.asarray(obs.dora_indicators, np.int64) // 4, minlength=34) / 4
    np.testing.assert_array_equal(features[7], indicators)
    if features[30, 27 + obs.round_wind] != 1 or features[31, 27 + (pid + 4 - obs.oya) % 4] != 1:
        raise AssertionError("Wind/relative-seat mismatch")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--games", type=int, default=20)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(4)
    torch.manual_seed(20261111)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    device = torch.device("cuda:0")
    policy = FoldedPolicy.from_safetensors(args.weights).to(device).eval()
    original_hash = hashlib.sha256(args.weights.read_bytes()).hexdigest()
    oracle = Oracle(args.oracle)
    started = time.monotonic()
    counts = Counter()
    actions_seen = Counter()
    events_seen = Counter()
    decisions_by_seat = Counter()
    games = []
    legacy_mismatches = []
    failure_context = {}
    try:
        for game in range(args.games):
            seed = 2026111100 + game
            rng = np.random.default_rng(seed)
            env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=seed)
            adapters = [AkagiAdapter(seat) for seat in range(4)]
            observations = env.reset()
            steps = 0
            mode = "greedy_01" if game % 2 == 0 else "call_biased_legal"
            while not env.done():
                if not observations or steps >= 100000:
                    raise RuntimeError("Empty active observations or step limit")
                prepared = {}
                for pid, obs in observations.items():
                    failure_context = {"seed": seed, "step": steps, "seat": pid,
                                       "history": adapters[pid].history,
                                       "events": obs.new_events()}
                    events = [json.loads(e)["type"] for e in obs.new_events()]
                    events_seen.update(events)
                    view = VisibleObservation(obs)
                    decision = adapters[pid].prepare(view)
                    if adapters[pid].prepare(view) is not decision:
                        raise AssertionError("Same observation was applied twice")
                    public_planes(obs, decision.features)
                    live_mask = np.zeros(82, np.bool_)
                    for action in obs.legal_actions():
                        live_mask[action.encode()] = True
                    np.testing.assert_array_equal(live_mask, decision.legal_mask)
                    prepared[pid] = decision
                    decisions_by_seat[pid] += 1
                seats = list(prepared)
                x = torch.from_numpy(np.stack([prepared[p].features for p in seats])).to(device)
                legal = torch.from_numpy(np.stack([prepared[p].legal_mask for p in seats])).to(device)
                with torch.inference_mode():
                    logits = policy(x)
                    chosen_ids = masked_logits(logits, legal).argmax(1).tolist()
                    cpu_logits = logits.cpu().numpy()
                selected = {}
                for i, pid in enumerate(seats):
                    decision = prepared[pid]
                    counts["decisions"] += 1
                    if counts["decisions"] % 25 == 0 or any(
                        json.loads(e)["type"] in ("start_kyoku", "reach", "kakan", "ankan", "daiminkan")
                        for e in observations[pid].new_events()
                    ):
                        mismatch = oracle.check(pid, adapters[pid], decision, cpu_logits[i])
                        counts["oracle_checks"] += 1
                        counts["legacy_legal_set_differences"] += int(mismatch is not None)
                        if mismatch is not None:
                            legacy_mismatches.append({"seed": seed, "step": steps, **mismatch})
                    action_id = chosen_ids[i]
                    if mode == "call_biased_legal":
                        candidates = [aid for aid in decision.representatives if aid >= 37 and aid != 81]
                        action_id = 79 if 79 in candidates else int(rng.choice(candidates or list(decision.representatives)))
                    selected[pid] = decision.resolve(action_id)
                    if selected[pid].encode() != action_id or selected[pid] not in decision.actions:
                        raise AssertionError("Resolved physical action is not legal")
                    actions_seen[str(selected[pid].action_type)] += 1
                observations = env.step(selected)
                steps += 1
            rewards = terminal_rewards(list(env.ranks()))
            games.append({"seed": seed, "mode": mode, "steps": steps, "scores": list(env.scores()),
                          "ranks": list(env.ranks()), "rewards": rewards.tolist(),
                          "rounds_observed_by_seat": [a.rounds_seen for a in adapters]})
            print(f"game {game + 1}/{args.games}: {mode}, {steps} steps, checks={counts['oracle_checks']}", flush=True)
    except BaseException:
        (args.out / "failure-context.json").write_text(json.dumps(failure_context, indent=2), encoding="utf-8")
        raise
    finally:
        oracle.close()
    if hashlib.sha256(args.weights.read_bytes()).hexdigest() != original_hash:
        raise AssertionError("Original weights changed")
    result = {"feature_contract": FEATURE_CONTRACT, "rank_rewards": RANK_REWARDS,
              "source_weight_sha256": original_hash, "counts": dict(counts),
              "decisions_by_seat": dict(decisions_by_seat), "actions_seen": dict(actions_seen),
              "events_seen_per_player": dict(events_seen), "games": games,
              "seconds": time.monotonic() - started, "oracle_feature_max_error": 0,
              "oracle_legal_mask_disagreements": 0, "oracle_physical_ranking_disagreements": 0,
              "scope": "Bounded correctness integration, not throughput/strength evaluation or PPO"}
    (args.out / "verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (args.out / "legacy-legal-mismatches.json").write_text(json.dumps(legacy_mismatches, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "games"}, indent=2))


if __name__ == "__main__":
    main()
