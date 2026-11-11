"""Run seeded random legal policies through complete Tenhou hanchan games."""
import argparse
import importlib.metadata
import json
import time
from pathlib import Path

from riichienv import GameRule, RiichiEnv
from riichienv.agents import RandomAgent


def play(seed):
    env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=seed)
    agents = {pid: RandomAgent(seed=seed * 4 + pid) for pid in range(4)}
    observations = env.reset()
    steps = decisions = 0
    while not env.done():
        if not observations or steps >= 100000:
            raise RuntimeError(f"Empty observations or step limit: seed={seed}, step={steps}")
        actions = {}
        for pid, obs in observations.items():
            if pid not in agents or not obs.legal_actions():
                raise RuntimeError(f"Invalid player or no legal action: {seed}, {pid}")
            actions[pid] = agents[pid].act(obs)
        decisions += len(actions)
        observations = env.step(actions)
        steps += 1
    scores, ranks = list(env.scores()), list(env.ranks())
    if len(scores) != 4 or sorted(ranks) not in ([0, 1, 2, 3], [1, 2, 3, 4]):
        raise RuntimeError(f"Invalid terminal result: {scores}, {ranks}")
    return {"seed": seed, "steps": steps, "decisions": decisions,
            "scores": scores, "ranks": ranks, "done": env.done()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--games", type=int, default=10)
    args = parser.parse_args()
    if args.games < 1 or args.out.exists():
        raise ValueError("Require positive game count and a new output path")
    started = time.monotonic()
    games = [play(20261111 + i) for i in range(args.games)]
    if play(games[0]["seed"]) != games[0]:
        raise AssertionError("Seeded replay was not deterministic")
    result = {"riichienv": importlib.metadata.version("riichienv"),
              "mode": "4p-red-half", "rule": "default_tenhou",
              "policy": "RandomAgent (not Akagi)", "games": games,
              "deterministic_replay": True, "seconds": time.monotonic() - started}
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
