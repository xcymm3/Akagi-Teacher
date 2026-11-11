import unittest
import numpy as np
import torch

from ppo_core import PPOConfig, log_distribution, loss_terms, terminal_gae
from train_ppo import evaluation_jobs, paired_evaluation


class PPOTests(unittest.TestCase):
    def test_terminal_reward_reaches_all_hanchan_decisions(self):
        values = np.linspace(-1, 1, 1000, dtype=np.float32)
        advantages, returns = terminal_gae(values, 2.)
        np.testing.assert_allclose(returns, 2., atol=1e-6)
        np.testing.assert_allclose(advantages, 2.-values, atol=1e-6)

    def test_rank_rewards_and_trajectory_boundaries(self):
        for reward in (2., 1., 0., -3.):
            _, returns = terminal_gae([.5, -.2, .1], reward)
            np.testing.assert_allclose(returns, reward, atol=1e-6)
        with self.assertRaises(ValueError):
            terminal_gae([], 2.)

    def test_discounted_gae_small_hand_calculation(self):
        # r=[0,2], V=[.5,1], gamma=.9, lambda=.8: delta=[.4,1].
        adv, returns = terminal_gae([.5, 1.], 2., .9, .8)
        np.testing.assert_allclose(adv, [1.12, 1.], atol=1e-6)
        np.testing.assert_allclose(returns, [1.62, 2.], atol=1e-6)

    def test_masked_sampling_and_entropy_finite(self):
        logits = torch.full((128, 82), 1e5)
        masks = torch.zeros_like(logits, dtype=torch.bool)
        masks[:, 7] = True
        logits[:, 7] = -1e5
        logp = log_distribution(logits, masks)
        self.assertTrue(torch.isfinite(logp).all())
        self.assertTrue((torch.multinomial(logp.exp(), 1) == 7).all())
        self.assertEqual(float(-(logp.exp()*logp).sum()), 0.)
        with self.assertRaises(ValueError):
            log_distribution(logits, torch.zeros_like(masks))

    def test_clipped_objective_and_exact_reference_kl(self):
        logits = torch.zeros((2, 82), requires_grad=True)
        masks = torch.zeros((2, 82), dtype=torch.bool); masks[:, :2] = True
        selected = log_distribution(logits, masks)[:, 0].detach()
        old = selected - torch.tensor([1.2, .8]).log()
        terms = loss_terms(logits, torch.zeros(2, requires_grad=True), logits.detach(), masks,
                           torch.zeros(2, dtype=torch.int64), old, torch.zeros(2),
                           torch.tensor([1., -1.]), torch.tensor([2., -3.]), PPOConfig())
        self.assertAlmostEqual(float(terms[0].detach()), -.05, places=6)
        self.assertAlmostEqual(float(terms[1].detach()), 3.25, places=6)
        self.assertAlmostEqual(float(terms[3].detach()), 0., places=6)
        sum(terms[:4]).backward()
        self.assertTrue(torch.isfinite(logits.grad).all())

    def test_evaluation_rotates_seats_and_clusters_seed(self):
        jobs = evaluation_jobs(410000000, 3)
        self.assertEqual(len(jobs), 12)
        for seed in range(410000000, 410000003):
            self.assertEqual([j["seat"] for j in jobs if j["seed"] == seed], [0, 1, 2, 3])
        games = [dict(seed=j["seed"], learner_seat=j["seat"], ranks=[1, 2, 3, 4], rewards=[2, 1, 0, -3]) for j in jobs]
        result = dict(seed_start=410000000, seeds=3, games=games)
        paired = paired_evaluation(result, result)
        self.assertEqual(paired["mean_deltas_reward_rank_fourth"], [0., 0., 0.])
        self.assertEqual(paired["paired_95pct_ci_reward_rank_fourth"], [[0., 0.]]*3)


if __name__ == "__main__":
    unittest.main()
