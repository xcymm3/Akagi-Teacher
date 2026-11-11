"""Protocol and isolation tests that require no CUDA device."""
import json
import multiprocessing as mp
from pathlib import Path
import tempfile
import unittest

import numpy as np

from run_parallel import compare_reference, worker
from run_stability import Table


class ParallelTests(unittest.TestCase):
    def test_table_rejects_wrong_action_count(self):
        table = Table(2026111100)
        table.prepare()
        with self.assertRaisesRegex(ValueError, "count mismatch"):
            table.advance([])
        self.assertEqual(table.steps, 0)

    def test_same_seed_independent_tables(self):
        left, right = Table(2026111100), Table(2026111100)
        for _ in range(20):
            x, masks = left.prepare()
            y, other_masks = right.prepare()
            np.testing.assert_array_equal(x, y)
            np.testing.assert_array_equal(masks, other_masks)
            actions = [int(np.flatnonzero(mask)[0]) for mask in masks]
            self.assertEqual(left.advance(actions), right.advance(actions))
        self.assertEqual(left.digest.hexdigest(), right.digest.hexdigest())

    def test_digest_independent_of_simultaneous_seat_order(self):
        left, right = Table(2026111100), Table(2026111100)
        simultaneous = False
        for _ in range(1000):
            right.obs = dict(reversed(list(right.obs.items())))
            _, masks = left.prepare()
            _, other = right.prepare()
            simultaneous |= len(masks) > 1
            done = left.advance([int(np.flatnonzero(mask)[0]) for mask in masks])
            self.assertEqual(done, right.advance([int(np.flatnonzero(mask)[0]) for mask in other]))
            self.assertEqual(left.digest.hexdigest(), right.digest.hexdigest())
            if simultaneous or done:
                break
        self.assertTrue(simultaneous)

    def test_worker_rejects_stale_response(self):
        context = mp.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(target=worker, args=(child, 0, [11, 12, 13, 14], 4))
        process.start()
        child.close()
        try:
            self.assertTrue(parent.poll(30))
            self.assertEqual(parent.recv()["kind"], "ready")
            parent.send("start")
            self.assertTrue(parent.poll(30))
            request = parent.recv()
            self.assertEqual(request["kind"], "infer")
            self.assertEqual(request["features"].shape[1:], (39, 34))
            self.assertGreaterEqual(len(request["features"]), 4)
            choices = [int(np.flatnonzero(mask)[0]) for mask in request["masks"]]
            parent.send((request["sequence"] + 1, choices))
            self.assertTrue(parent.poll(30))
            error = parent.recv()
            self.assertEqual(error["kind"], "error")
            self.assertIn("Stale or misrouted", error["traceback"])
            process.join(10)
            self.assertNotEqual(process.exitcode, 0)
        finally:
            parent.close()
            if process.is_alive():
                process.terminate()
            process.join(5)

    def test_reference_checks_action_trace_not_only_score(self):
        game = dict(seed=1, scores=[25000]*4, ranks=[1, 2, 3, 4], steps=1,
                    decisions=1, rewards=[2, 1, 0, -3], action_sha256="original")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference.json"
            path.write_text(json.dumps({"games": [game]}))
            self.assertEqual(compare_reference([game], path), [])
            changed = dict(game, action_sha256="changed")
            self.assertEqual(compare_reference([changed], path)[0]["field"], "action_sha256")


if __name__ == "__main__":
    unittest.main()
