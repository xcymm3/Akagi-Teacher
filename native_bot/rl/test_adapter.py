"""Focused contract/regression tests; live differential checks are separate."""
import itertools
import json
import unittest
from pathlib import Path

import numpy as np
from riichienv import Action, ActionType, GameRule, RiichiEnv

from _akagi_bridge import ReplayEncoder, action_table, quantize, rank_actions
from adapter import AkagiAdapter, actions_json, public_event, terminal_rewards


class VisibleObservation:
    """Pass only the public/per-seat surface, never env or opponents' hands."""
    def __init__(self, obs, events=None):
        self.player_id = obs.player_id
        self.hand = obs.hand
        self._events = obs.new_events() if events is None else events
        self._actions = obs.legal_actions()

    def new_events(self):
        return self._events

    def legal_actions(self):
        return self._actions

    @property
    def hands(self):
        raise AssertionError("Adapter must not read other players' concealed hands")


HAND = ["2m", "3m", "4m", "5m", "6m", "7m", "2p", "3p", "4p", "5p", "6p", "7p", "5s"]
JUNK = ["1m", "1m", "9m", "9m", "1p", "9p", "1s", "9s", "E", "S", "W", "N", "P"]


def start(hand=HAND, seat=1):
    return [{"type": "start_game"}, {"type": "start_kyoku", "bakaze": "S", "kyoku": 3,
             "honba": 2, "kyotaku": 1, "oya": 2, "scores": [20000, 25000, 30000, 24000],
             "dora_marker": "9p", "tehais": [hand if pid == seat else JUNK for pid in range(4)]}]


def fixture_observation(events, hand, seat=1, actions=None):
    # Deliberately synthetic hand/legal set for rare encoding contracts.
    class Fixture:
        player_id = seat

        def new_events(self):
            return events

        def legal_actions(self):
            return actions or [Action(ActionType.PASS)]
    obs = Fixture()
    def tid(t):
        if t in "ESWNPFC" and len(t) == 1:
            return (27 + "ESWNPFC".index(t)) * 4
        base = ("mps".index(t[1]) * 9 + int(t[0]) - 1) * 4
        return base + (1 if t[0] == "5" and not t.endswith("r") else 0)
    obs.hand = [tid(t) for t in hand]
    return obs


class AdapterTests(unittest.TestCase):
    def test_rewards_one_based_all_permutations(self):
        for ranks in itertools.permutations([1, 2, 3, 4]):
            rewards = terminal_rewards(ranks)
            self.assertEqual(float(rewards.sum()), 0)
            self.assertEqual(rewards[list(ranks).index(1)], 2)
            self.assertEqual(rewards[list(ranks).index(3)], 0)
        for bad in ([0, 1, 2, 3], [1, 1, 3, 4], [1, 2, 3], [True, 2, 3, 4]):
            with self.assertRaises(ValueError):
                terminal_rewards(bad)

    def test_all_action_ids_and_red_five_representatives(self):
        cases = []
        for index in range(34):
            cases.append((Action(ActionType.DISCARD, index * 4), index))
            cases.append((Action(ActionType.DAIMINKAN, index * 4, [index * 4 + j for j in (1, 2, 3)]), 42 + index))
            cases.append((Action(ActionType.ANKAN, index * 4, [index * 4 + j for j in range(4)]), 42 + index))
            cases.append((Action(ActionType.KAKAN, index * 4 + 3, [index * 4 + j for j in range(3)]), 42 + index))
        cases.extend([(Action(ActionType.RIICHI), 37), (Action(ActionType.CHI, 0, [4, 8]), 38),
                      (Action(ActionType.CHI, 4, [0, 8]), 39), (Action(ActionType.CHI, 8, [0, 4]), 40),
                      (Action(ActionType.PON, 4, [5, 6]), 41), (Action(ActionType.RON), 79),
                      (Action(ActionType.TSUMO), 79), (Action(ActionType.KYUSHU_KYUHAI), 80),
                      (Action(ActionType.PASS), 81)])
        for action, expected in cases:
            mask, pairs = action_table(actions_json([action], 0))
            self.assertEqual(np.flatnonzero(np.frombuffer(mask, dtype=np.uint8)).tolist(), [expected])
            self.assertEqual(pairs, [(expected, 0)])
            self.assertEqual(action.encode(), expected)
        for red in (16, 52, 88):
            for ids in ([red, red + 1], [red + 1, red], [red]):
                actions = [Action(ActionType.DISCARD, tid) for tid in ids]
                _, pairs = action_table(actions_json(actions, 0))
                self.assertEqual(ids[pairs[0][1]], red + 1 if len(ids) == 2 else red)
        actions = [Action(ActionType.PON, 52, [53, 54]), Action(ActionType.PON, 52, [53, 55])]
        self.assertEqual(action_table(actions_json(actions, 0))[1], [(41, 0)])

    def test_ties_and_illegal_actions(self):
        actions = [Action(ActionType.PASS), Action(ActionType.PON, 4, [5, 6])]
        ranked = rank_actions(actions_json(actions, 0), [0.0] * 82)
        self.assertEqual(ranked, [(1, 0.5), (0, 0.5)])
        with self.assertRaises(ValueError):
            action_table("[]")
        for action in (Action(ActionType.KITA), Action(ActionType.DISCARD), Action(ActionType.ANKAN)):
            with self.assertRaises(ValueError):
                action_table(actions_json([action], 0))
        with self.assertRaises(ValueError):
            rank_actions(actions_json(actions, 0), [float("nan")] * 82)

    def test_quantization_matches_extractor_round_half_up(self):
        x = np.zeros((39, 34), dtype=np.float32)
        x.flat[:6] = [-1, 0, 2, 4, 8, 1]
        result = quantize(x.ravel().tolist())
        self.assertEqual(list(result[:6]), [0, 0, 128, 255, 255, 64])

    def test_public_boundary_and_bad_events(self):
        event = start()[1]
        clean = public_event(event, 1)
        self.assertEqual(clean["tehais"][0], ["?"] * 13)
        self.assertEqual(clean["tehais"][1], HAND)
        self.assertEqual(public_event({"type": "tsumo", "actor": 0, "pai": "5mr"}, 1)["pai"], "?")
        self.assertEqual(public_event({"type": "hora", "actor": 0, "target": 1, "ura_markers": ["P"]}, 1),
                         {"type": "hora", "actor": 0, "target": 1})
        for bad in ({"type": "nukidora", "actor": 0}, {"type": "tsumo", "actor": 4, "pai": "1m"},
                    {"type": "dahai", "actor": 1, "pai": "?", "tsumogiri": True},
                    {"type": "chi", "actor": 1, "target": 0, "pai": "1m", "consumed": ["2m"]}):
            with self.assertRaises(ValueError):
                public_event(bad, 1)

    def test_relative_planes_and_last_discard(self):
        events = start() + [{"type": "tsumo", "actor": 0, "pai": "9s"},
                            {"type": "dahai", "actor": 0, "pai": "9s", "tsumogiri": True}]
        d = AkagiAdapter(1).prepare(fixture_observation(events, HAND))
        self.assertEqual(d.features.shape, (39, 34))
        self.assertEqual(d.features[29, 26], 1)  # discard tile, never pid
        self.assertEqual(d.features[29, 0], 0)
        self.assertEqual(d.features[12, 26], 0.25)  # pid 0 is relative seat 3
        self.assertEqual(d.features[30, 28], 1)  # south round
        self.assertEqual(d.features[31, 30], 1)  # seat 1 relative to dealer 2 = north
        np.testing.assert_array_equal(d.features[25:29, 0], np.array([.5, .6, .48, .4], np.float32))
        self.assertEqual(d.features[7, 17], .25)
        self.assertEqual(d.features[8, 9], .25)  # 9p indicator -> 1p
        self.assertTrue((d.features[34] == 0).all())  # original MJAI legacy counter
        self.assertTrue((d.features[37] == .25).all())
        for illegal in (34, 36, 76, 78, -1, 82, True, 1.5):
            with self.assertRaises(ValueError):
                d.resolve(illegal)

    def test_riichi_two_step_and_deposit(self):
        events = start() + [{"type": "tsumo", "actor": 1, "pai": "S"}, {"type": "reach", "actor": 1}]
        adapter = AkagiAdapter(1)
        d = adapter.prepare(fixture_observation(events, HAND + ["S"], actions=[Action(ActionType.DISCARD, 112)]))
        self.assertEqual(d.features[38, 0], 0)  # not accepted before declaration discard
        follow = [{"type": "dahai", "actor": 1, "pai": "S", "tsumogiri": True},
                  {"type": "reach_accepted", "actor": 1}]
        d = adapter.prepare(fixture_observation(follow, HAND))
        self.assertEqual(d.features[38, 0], 1)
        self.assertEqual(d.features[25, 0], np.float32(.48))
        self.assertEqual(d.features[33, 0], .5)
        self.assertTrue((d.features[21:25] == 0).all())  # legacy declaration-tile planes

    def test_chankan_and_hidden_draw_noninterference(self):
        events = start() + [
            {"type": "tsumo", "actor": 2, "pai": "5s"},
            {"type": "dahai", "actor": 2, "pai": "5s", "tsumogiri": True},
            {"type": "pon", "actor": 0, "target": 2, "pai": "5s", "consumed": ["5s", "5s"]},
            {"type": "dahai", "actor": 0, "pai": "E", "tsumogiri": False},
            {"type": "tsumo", "actor": 0, "pai": "5s"},
            {"type": "kakan", "actor": 0, "pai": "5s"}]
        a = AkagiAdapter(1)
        d = a.prepare(fixture_observation(events, HAND, actions=[Action(ActionType.RON), Action(ActionType.PASS)]))
        self.assertEqual(d.features[29, 22], 1)
        self.assertEqual(d.features[5, 0], 1)  # legacy hidden-draw placeholder, not actual kan tile
        self.assertEqual(a.encoder.replay_legal_mask()[79], 1)
        altered = json.loads(json.dumps(events))
        altered[1]["tehais"][0] = ["C"] * 13
        altered[-2]["pai"] = "1m"
        other = AkagiAdapter(1).prepare(fixture_observation(altered, HAND, actions=[Action(ActionType.RON), Action(ActionType.PASS)]))
        np.testing.assert_array_equal(d.features, other.features)
        a.encoder.feed('{"type":"tsumo","actor":0,"pai":"?"}')
        self.assertEqual(a.encoder.replay_legal_mask()[79], 0)
        a.encoder.feed('{"type":"dahai","actor":0,"pai":"P","tsumogiri":true}')
        self.assertEqual(a.encoder.replay_legal_mask()[79], 0)

    def test_late_kyushu_uses_live_legality_not_legacy_replay(self):
        case = json.loads((Path(__file__).parent / "fixtures/late-kyushu.json").read_text())
        query = case["query"]
        seat = query["seat"]
        events = [json.loads(line) for line in query["events"]]
        hand = list(events[0]["tehais"][seat])
        own_discards = 0
        for event in events[1:]:
            if event.get("actor") == seat:
                if event["type"] == "tsumo":
                    hand.append(event["pai"])
                elif event["type"] == "dahai":
                    hand.remove(event["pai"])
                    own_discards += 1
        self.assertGreater(own_discards, 0)
        actions = [Action(ActionType.DISCARD, action["tile"]) for action in query["actions"]]
        adapter = AkagiAdapter(seat)
        decision = adapter.prepare(fixture_observation(events, hand, seat=seat, actions=actions))
        self.assertEqual(adapter.encoder.replay_legal_mask()[80], 1)
        self.assertFalse(decision.legal_mask[80])
        with self.assertRaises(ValueError):
            decision.resolve(80)

    def test_ankan_dora_and_rinshan(self):
        hand = ["5mr", "5m", "5m", "5m", "1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p"]
        events = start(hand) + [{"type": "tsumo", "actor": 1, "pai": "1s"},
                {"type": "ankan", "actor": 1, "consumed": hand[:4]},
                {"type": "dora", "dora_marker": "C"}, {"type": "tsumo", "actor": 1, "pai": "2s"}]
        d = AkagiAdapter(1).prepare(fixture_observation(events, hand[4:] + ["1s", "2s"]))
        self.assertEqual(d.features[13, 4], 1)  # four kan tiles
        self.assertEqual(d.features[5, 19], 1)
        self.assertEqual(d.features[7, 33], .25)
        self.assertEqual(d.features[8, 31], .25)
        self.assertEqual(d.features[4, 4], 0)  # red five moved out of concealed hand

    def test_retry_reset_and_wrong_seat(self):
        env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=123)
        obs = next(iter(env.reset().values()))
        public = VisibleObservation(obs)
        adapter = AkagiAdapter(obs.player_id)
        first = adapter.prepare(public)
        history = list(adapter.history)
        self.assertIs(adapter.prepare(public), first)
        self.assertEqual(history, adapter.history)
        with self.assertRaises(ValueError):
            AkagiAdapter((obs.player_id + 1) % 4).prepare(public)
        adapter.reset()
        np.testing.assert_array_equal(adapter.prepare(public).features, first.features)
        broken = VisibleObservation(obs, events=[])
        with self.assertRaises(ValueError):
            AkagiAdapter(obs.player_id).prepare(broken)

    def test_terminal_and_next_hand_reset(self):
        encoder = ReplayEncoder(1)
        for e in start():
            encoder.feed(json.dumps(public_event(e, 1)))
        encoder.feed('{"type":"ryukyoku"}')
        with self.assertRaises(ValueError):
            encoder.encode()
        next_hand = start()[1]
        next_hand["honba"] = 3
        encoder.feed(json.dumps(public_event(next_hand, 1)))
        self.assertEqual(np.asarray(encoder.encode()).reshape(39, 34)[32, 0], .75)
        encoder.feed('{"type":"end_game"}')
        with self.assertRaises(ValueError):
            encoder.encode()
        encoder.feed('{"type":"start_game"}')
        with self.assertRaises(ValueError):
            encoder.encode()


if __name__ == "__main__":
    unittest.main(verbosity=2)
