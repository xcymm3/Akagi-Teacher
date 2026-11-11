"""Full-hanchan on-policy PPO math. No GRP or per-hand reward substitution."""
from dataclasses import asdict, dataclass
import hashlib

import numpy as np
import torch
from torch.nn import functional as F

from model import masked_logits


@dataclass
class PPOConfig:
    actor_lr: float = 1e-5
    value_lr: float = 1e-4
    warmup_lr: float = 1e-3
    clip: float = .05
    value_clip: float = .2
    epochs: int = 2
    minibatch: int = 512
    value_coef: float = .5
    entropy_coef: float = .001
    reference_kl_coef: float = .02
    target_kl: float = .01
    max_grad_norm: float = .5
    gamma: float = 1.0
    gae_lambda: float = 1.0


def log_distribution(logits, masks):
    # Finite illegal logits avoid 0 * (-inf - -inf) in entropy and exact KL.
    return F.log_softmax(masked_logits(logits, masks).masked_fill(~masks, -1e9), dim=-1)


def terminal_gae(values, reward, gamma=1., lam=1.):
    """One complete learner-seat trajectory; ONLY its last transition is terminal.

    With gamma=lambda=1, returns equal the undiscounted final rank reward at
    every decision, avoiding attenuation across a long, sparsely rewarded game.
    """
    values = np.asarray(values, dtype=np.float32)
    if values.ndim != 1 or len(values) == 0 or not np.isfinite(values).all():
        raise ValueError("Nonempty finite value trajectory required")
    if not np.isfinite(reward) or not 0 <= gamma <= 1 or not 0 <= lam <= 1:
        raise ValueError("Invalid reward or GAE parameters")
    advantages = np.empty_like(values)
    carry = next_value = 0.
    for i in range(len(values)-1, -1, -1):
        r = float(reward) if i == len(values)-1 else 0.
        delta = r + gamma * next_value - float(values[i])
        carry = delta + gamma * lam * carry
        advantages[i] = carry
        next_value = float(values[i])
    return advantages, advantages + values


def parameter_hash(module):
    digest = hashlib.sha256()
    for name, tensor in module.state_dict().items():
        digest.update(name.encode())
        digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def make_optimizer(model, config):
    return torch.optim.Adam([
        {"params": model.policy.parameters(), "lr": config.actor_lr},
        {"params": model.value_head.parameters(), "lr": config.value_lr}], eps=1e-5)


def loss_terms(logits, values, reference_logits, masks, actions, old_logp,
               old_values, advantages, returns, config):
    logp = log_distribution(logits, masks)
    ref_logp = log_distribution(reference_logits, masks)
    selected = logp.gather(1, actions[:, None]).squeeze(1)
    log_ratio = selected - old_logp
    ratio = log_ratio.exp()
    policy_loss = -torch.minimum(ratio * advantages,
                                ratio.clamp(1-config.clip, 1+config.clip) * advantages).mean()
    clipped_values = old_values + (values-old_values).clamp(-config.value_clip, config.value_clip)
    value_loss = .5 * torch.maximum((values-returns).square(), (clipped_values-returns).square()).mean()
    entropy = -(logp.exp() * logp).sum(1).mean()
    reference_kl = (logp.exp() * (logp-ref_logp)).sum(1).mean()
    old_kl = ((ratio-1)-log_ratio).mean()
    clip_fraction = ((ratio-1).abs() > config.clip).float().mean()
    return policy_loss, value_loss, entropy, reference_kl, old_kl, clip_fraction


def update(model, reference, optimizer, batch, config, rng, warmup=False):
    model.train()
    model.policy.requires_grad_(not warmup)
    optimizer.param_groups[0]["lr"] = 0. if warmup else config.actor_lr
    optimizer.param_groups[1]["lr"] = config.warmup_lr if warmup else config.value_lr
    device = next(model.parameters()).device
    n = len(batch["actions"])
    if n < 2:
        raise ValueError("At least two learner transitions required")
    advantages = batch["advantages"].astype(np.float32)
    advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
    arrays = dict(batch, advantages=advantages)
    stats = []
    stopped = False
    max_gradient = 0.
    for _ in range(config.epochs):
        for start in range(0, n, config.minibatch):
            # One permutation per epoch, not one per minibatch.
            if start == 0:
                order = rng.permutation(n)
            idx = order[start:start+config.minibatch]
            t = {key: torch.from_numpy(value[idx]).to(device) for key, value in arrays.items()}
            logits, values = model(t["features"])
            with torch.no_grad():
                ref_logits = reference(t["features"])
            terms = loss_terms(logits, values, ref_logits, t["masks"], t["actions"],
                               t["old_logp"], t["old_values"], t["advantages"], t["returns"], config)
            pg, vf, entropy, ref_kl, old_kl, clip_fraction = terms
            if not torch.isfinite(torch.stack(terms)).all():
                raise FloatingPointError("Non-finite PPO terms")
            if not warmup and old_kl.item() > config.target_kl:
                stopped = True
                break
            # Warmup only fits the zero-initialized value head; no shared-body gradient.
            loss = F.mse_loss(values, t["returns"]) if warmup else (
                pg + config.value_coef*vf - config.entropy_coef*entropy + config.reference_kl_coef*ref_kl)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            grad = torch.nn.utils.clip_grad_norm_(model.parameters(), config.max_grad_norm, error_if_nonfinite=True)
            max_gradient = max(max_gradient, float(grad))
            optimizer.step()
            stats.append([float(term.detach()) for term in terms])
        if stopped:
            break
    model.policy.requires_grad_(True)
    model.eval()
    means = np.mean(stats, axis=0).tolist() if stats else [0.] * 6
    result = dict(zip(("policy_loss", "value_loss", "entropy", "reference_kl", "old_kl", "clip_fraction"), means))
    result.update(minibatches=len(stats), early_stop=stopped, max_gradient_norm=max_gradient,
                  warmup=warmup, transitions=n,
                  return_mean=float(batch["returns"].mean()), return_std=float(batch["returns"].std()))
    return result


def checkpoint(path, model, optimizer, config, rng, metadata):
    # Checkpoints are written only at rollout/update boundaries; never overwrite.
    payload = {"model": model.state_dict(), "optimizer": optimizer.state_dict(),
               "config": asdict(config), "numpy_rng": rng.bit_generator.state,
               "torch_rng": torch.get_rng_state(), "cuda_rng": torch.cuda.get_rng_state_all(),
               "metadata": metadata}
    with open(path, "xb") as stream:
        torch.save(payload, stream)


def restore(path, model, optimizer, rng):
    # Only trusted checkpoints produced by this experiment may be loaded.
    payload = torch.load(path, map_location=next(model.parameters()).device, weights_only=False)
    model.load_state_dict(payload["model"])
    optimizer.load_state_dict(payload["optimizer"])
    rng.bit_generator.state = payload["numpy_rng"]
    torch.set_rng_state(payload["torch_rng"].cpu())
    torch.cuda.set_rng_state_all([state.cpu() for state in payload["cuda_rng"]])
    return payload
