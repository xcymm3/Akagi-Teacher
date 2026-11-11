"""Four-player RiichiEnv observations -> Akagi's original MJAI feature contract.

Only per-player observations enter this module: never pass the omniscient env.
Actions come from the live environment, while features use Akagi's old replay
semantics, including its legacy counters. See STAGE3_RESULTS.md for differences.
"""
import json
import re
from dataclasses import dataclass

import numpy as np
import torch

from _akagi_bridge import FEATURE_CONTRACT, ReplayEncoder, action_table, quantize
from model import masked_logits


ACTION_NAMES = ("Discard", "Chi", "Pon", "Daiminkan", "Ron", "Riichi",
                "Tsumo", "Pass", "Ankan", "Kakan", "KyushuKyuhai")
RANK_REWARDS = (2.0, 1.0, 0.0, -3.0)


def terminal_rewards(ranks):
    """RiichiEnv's one-based terminal ranks in absolute seat order."""
    if len(ranks) != 4 or any(type(rank) is not int for rank in ranks) or sorted(ranks) != [1, 2, 3, 4]:
        raise ValueError("Expected one-based ranks [1,2,3,4] in seat order")
    return np.asarray([RANK_REWARDS[rank - 1] for rank in ranks], dtype=np.float32)


def seat_id(value):
    if type(value) is not int or not 0 <= value < 4:
        raise ValueError("Invalid four-player seat")
    return value


def tile(value, hidden=False):
    if hidden and value == "?":
        return value
    if not isinstance(value, str):
        raise ValueError("Expected MJAI tile string")
    if value in "ESWNPFC" and len(value) == 1:
        return value
    if re.fullmatch(r"[1-7]z", value):
        return "ESWNPFC"[int(value[0]) - 1]
    if re.fullmatch(r"[1-9][mps]", value) or re.fullmatch(r"5[mps]r", value):
        return value
    raise ValueError(f"Invalid visible tile: {value!r}")


def public_event(raw, seat):
    """Allowlist and redact BEFORE handing any event to the replay engine."""
    event = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(event, dict):
        raise ValueError("Expected an MJAI object")
    kind = event.get("type")
    if kind == "start_game":
        return {"type": kind}
    if kind == "start_kyoku":
        if len(event["tehais"]) != 4 or len(event["scores"]) != 4:
            raise ValueError("Four-player round required")
        own = [tile(t) for t in event["tehais"][seat]]
        if len(own) != 13 or event["bakaze"] not in ("E", "S", "W", "N"):
            raise ValueError("Invalid initial hand or wind")
        result = {"type": kind, "bakaze": event["bakaze"], "kyoku": event["kyoku"],
                  "honba": event["honba"], "kyotaku": event.get("kyotaku", event.get("kyoutaku", 0)),
                  "oya": seat_id(event["oya"]), "scores": list(event["scores"]),
                  "dora_marker": tile(event["dora_marker"]),
                  "tehais": [own if pid == seat else ["?"] * 13 for pid in range(4)]}
        for name in ("kyoku", "honba", "kyotaku"):
            if type(result[name]) is not int or not 0 <= result[name] <= 255:
                raise ValueError(f"Invalid {name}")
        if not 1 <= result["kyoku"] <= 4:
            raise ValueError("MJAI kyoku must be 1..4")
        if any(type(score) is not int or not -(2**31) <= score < 2**31 for score in result["scores"]):
            raise ValueError("Invalid scores")
        return result
    if kind in ("tsumo", "dahai", "chi", "pon", "daiminkan", "kan", "ankan", "kakan",
                "reach", "reach_accepted", "hora"):
        result = {"type": kind, "actor": seat_id(event["actor"])}
        if kind == "tsumo":
            result["pai"] = tile(event["pai"]) if result["actor"] == seat else "?"
        elif kind in ("dahai", "chi", "pon", "daiminkan", "kan", "kakan"):
            result["pai"] = tile(event["pai"])
        if kind == "dahai":
            if type(event.get("tsumogiri")) is not bool:
                raise ValueError("dahai requires a boolean tsumogiri")
            result["tsumogiri"] = event["tsumogiri"]
        if kind in ("chi", "pon", "daiminkan", "kan", "ankan"):
            consumed = [tile(t) for t in event["consumed"]]
            expected = {"chi": 2, "pon": 2, "daiminkan": 3, "kan": 3, "ankan": 4}[kind]
            if len(consumed) != expected:
                raise ValueError("Invalid consumed tile count")
            result["consumed"] = consumed
        if kind in ("chi", "pon", "daiminkan", "kan", "hora"):
            result["target"] = seat_id(event["target"])
        return result
    if kind == "dora":
        return {"type": kind, "dora_marker": tile(event["dora_marker"])}
    if kind in ("ryukyoku", "end_kyoku", "end_game"):
        return {"type": kind}
    raise ValueError(f"Unsupported event: {kind!r}")


def actions_json(actions, seat):
    serialized = []
    for action in actions:
        entry = action.to_dict()
        kind = entry["type"]
        if type(kind) is not int or not 0 <= kind < len(ACTION_NAMES):
            raise ValueError("Unsupported four-player action")
        if entry.get("actor") not in (None, seat):
            raise ValueError("Legal action belongs to another seat")
        serialized.append({"action_type": ACTION_NAMES[kind], "tile": entry["tile"],
                           "consume_tiles": entry["consume_tiles"], "actor": entry.get("actor")})
    return json.dumps(serialized, separators=(",", ":"))


@dataclass(frozen=True)
class DecisionInput:
    features: np.ndarray
    legal_mask: np.ndarray
    actions: tuple
    representatives: dict
    legal_json: str

    def resolve(self, action_id):
        if isinstance(action_id, (bool, np.bool_)) or not isinstance(action_id, (int, np.integer)):
            raise ValueError("Action id must be an integer")
        if int(action_id) not in self.representatives:
            raise ValueError(f"Illegal action id {action_id}; legal={sorted(self.representatives)}")
        return self.actions[self.representatives[int(action_id)]]

    def quantized_features(self):
        data = np.frombuffer(quantize(self.features.ravel().tolist()), dtype=np.uint8)
        return (data.astype(np.float32) / np.float32(255) * np.float32(4)).reshape(39, 34)


class AkagiAdapter:
    def __init__(self, seat):
        self.seat = seat_id(seat)
        self.reset()

    def reset(self):
        self.encoder = ReplayEncoder(self.seat)
        self.history = []
        self.last_observation = None
        self.last_decision = None
        self.poisoned = False
        self.rounds_seen = 0

    def prepare(self, observation):
        if self.poisoned:
            raise RuntimeError("Adapter encountered an error; reset before reuse")
        if observation.player_id != self.seat:
            raise ValueError("Observation belongs to another seat")
        # new_events() returns a fixed delta, not a destructive read. Retrying the
        # same Observation must not apply riichi deposits/discards twice.
        if observation is self.last_observation:
            return self.last_decision
        events = [public_event(e, self.seat) for e in observation.new_events()]
        actions = tuple(observation.legal_actions())
        legal_json = actions_json(actions, self.seat)
        mask, pairs = action_table(legal_json)
        try:
            for event in events:
                if event["type"] == "start_game":
                    self.encoder = ReplayEncoder(self.seat)
                    self.history = []
                elif event["type"] == "start_kyoku":
                    self.history = []  # a hand boundary is a complete replay reset
                    self.rounds_seen += 1
                line = json.dumps(event, separators=(",", ":"))
                self.encoder.feed(line)
                self.history.append(line)
            features = np.asarray(self.encoder.encode(), dtype=np.float32).reshape(39, 34)
            # Fail closed if incremental events were lost, duplicated or stale.
            counts = np.bincount(np.asarray(observation.hand, dtype=np.int64) // 4, minlength=34)
            expected = counts[None, :] >= np.arange(1, 5)[:, None]
            if counts.shape != (34,) or not np.array_equal(features[:4], expected):
                raise ValueError("Replay hand differs from observation: missing/duplicate events")
            if not np.isfinite(features).all():
                raise ValueError("Non-finite encoded observation")
        except BaseException:
            self.poisoned = True
            raise
        features.setflags(write=False)
        legal = np.frombuffer(mask, dtype=np.uint8).astype(np.bool_)
        legal.setflags(write=False)
        decision = DecisionInput(features, legal, actions, dict(pairs), legal_json)
        self.last_observation, self.last_decision = observation, decision
        return decision


class AkagiAgent:
    """Greedy 01 inference. Riichi declaration and discard remain two env steps."""
    def __init__(self, policy, seat, device="cpu"):
        self.policy = policy
        self.adapter = AkagiAdapter(seat)
        self.device = torch.device(device)

    def reset(self):
        self.adapter.reset()

    def act(self, observation):
        decision = self.adapter.prepare(observation)
        with torch.inference_mode():
            x = torch.from_numpy(decision.features.copy()).unsqueeze(0).to(self.device)
            legal = torch.from_numpy(decision.legal_mask.copy()).unsqueeze(0).to(self.device)
            logits = self.policy(x)
            action_id = int(masked_logits(logits, legal).argmax(1).item())
        return decision.resolve(action_id)
