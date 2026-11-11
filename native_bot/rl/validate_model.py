"""Verify migration on validation shards, without running PPO or touching test data."""
import argparse
import hashlib
import importlib.util
import json
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file, save_file
from torch.nn import functional as F

from model import ActorCritic, FoldedPolicy, GEOMETRY, masked_logits


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def samples(directory, count):
    meta = json.loads((directory / "meta.json").read_text())
    for key in ("num_players", "channels", "tile_dim", "action_space", "obs_scale"):
        if float(meta[key]) != float(GEOMETRY[key]):
            raise ValueError(f"Invalid data geometry: {key}")
    shards = meta["shard_samples"]
    if meta["obs_len"] != 1326 or sum(shards) != meta["total_samples"]:
        raise ValueError("Invalid shard metadata")
    if count < len(shards):
        raise ValueError("Sample count must cover every validation shard")
    rng = np.random.default_rng(20261111)
    observations, masks, actions = [], [], []
    for i, size in enumerate(shards):
        n = count // len(shards) + (i < count % len(shards))
        indices = np.sort(rng.choice(size, size=n, replace=False))
        arrays = []
        for suffix, dtype, shape in (("obs", np.uint8, (size, 1326)),
                                     ("msk", np.uint8, (size, 82)),
                                     ("act", "<u2", (size,))):
            path = directory / f"{i}.{suffix}"
            if path.stat().st_size != int(np.prod(shape)) * np.dtype(dtype).itemsize:
                raise ValueError(f"Shard size mismatch: {path}")
            arrays.append(np.memmap(path, mode="r", dtype=dtype, shape=shape)[indices].copy())
        observations.append(arrays[0])
        masks.append(arrays[1])
        actions.append(arrays[2])
    x = torch.from_numpy(np.concatenate(observations)).float().div_(255).mul_(4).view(-1, 39, 34)
    mask_u8 = np.concatenate(masks)
    if not np.isin(mask_u8, [0, 1]).all():
        raise ValueError("Invalid mask values")
    mask = torch.from_numpy(mask_u8).bool()
    y = torch.from_numpy(np.concatenate(actions).astype(np.int64))
    if (y >= 82).any() or not mask.any(1).all() or not mask.gather(1, y[:, None]).all():
        raise ValueError("Invalid validation actions or masks")
    return x, mask, y, len(shards)


def assert_rejected(callback):
    try:
        callback()
    except (ValueError, RuntimeError, FileExistsError):
        return
    raise AssertionError("Invalid input was accepted")


def loading_checks(weights, directory):
    state = load_file(str(weights))
    key = "head.weight"
    cases = {}
    cases["missing"] = {k: v for k, v in state.items() if k != key}
    cases["unexpected"] = {**state, "bn.running_mean": torch.zeros(1)}
    cases["shape"] = {**state, key: state[key][:1].clone()}
    cases["dtype"] = {**state, key: state[key].double()}
    bad = state[key].clone()
    bad[0, 0] = float("nan")
    cases["nonfinite"] = {**state, key: bad}
    for name, altered in cases.items():
        path = directory / f"{name}.safetensors"
        save_file(altered, str(path))
        assert_rejected(lambda: FoldedPolicy.from_safetensors(path))
    path = directory / "metadata.safetensors"
    save_file(state, str(path), metadata={**GEOMETRY, "channels": "74"})
    assert_rejected(lambda: FoldedPolicy.from_safetensors(path))
    return list(cases) + ["metadata"]


def compare(model, state, reference, x, mask, device):
    model = model.to(device).eval()
    state = {k: v.to(device) for k, v in state.items()}
    max_error = 0.0
    disagreements = 0
    outputs = []
    min_margin = float("inf")
    with torch.inference_mode():
        for start in range(0, len(x), 256):
            batch = x[start:start + 256].to(device)
            legal = mask[start:start + 256].to(device)
            expected = reference(state, batch)
            actual = model(batch)
            torch.testing.assert_close(actual, expected, atol=1e-5, rtol=1e-5)
            max_error = max(max_error, (actual - expected).abs().max().item())
            chosen = masked_logits(actual, legal)
            disagreements += int((chosen.argmax(1) != masked_logits(expected, legal).argmax(1)).sum())
            margins = chosen.topk(2, dim=1).values
            min_margin = min(min_margin, (margins[:, 0] - margins[:, 1]).min().item())
            outputs.append(actual.cpu())
        single = torch.cat([model(row[None].to(device)).cpu() for row in x[:64]])
        combined = torch.cat(outputs)
        torch.testing.assert_close(single, combined[:64], atol=2e-3, rtol=1e-5)
        singleton_disagreements = int((masked_logits(single, mask[:64]).argmax(1) !=
                                      masked_logits(combined[:64], mask[:64]).argmax(1)).sum())
    if disagreements or singleton_disagreements:
        raise AssertionError("Policy actions differ after migration/batching")
    return combined, {"max_logit_error": max_error, "action_disagreements": disagreements,
                      "single_batch_max_error": (single - combined[:64]).abs().max().item(),
                      "single_batch_action_disagreements": singleton_disagreements,
                      "minimum_legal_top2_margin": min_margin}


def update_check(weights, x, legal, y, directory):
    model = ActorCritic(FoldedPolicy.from_safetensors(weights)).cuda()
    x, legal, y = x[:256].cuda(), legal[:256].cuda(), y[:256].cuda()
    before = {k: v.detach().clone() for k, v in model.policy.state_dict().items()}
    for parameter in model.policy.parameters():
        parameter.requires_grad_(False)
    target = torch.linspace(-3, 3, len(x), device=x.device)
    optimizer = torch.optim.Adam(model.value_head.parameters(), lr=1e-4)
    _, value = model(x)
    F.mse_loss(value, target).backward()
    optimizer.step()
    if any(not torch.equal(v, before[k]) for k, v in model.policy.state_dict().items()):
        raise AssertionError("Value warmup modified frozen policy")
    if not model.value_head.weight.abs().any():
        raise AssertionError("Value head did not update")
    for parameter in model.policy.parameters():
        parameter.requires_grad_(True)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-5)
    optimizer.zero_grad(set_to_none=True)
    logits, value = model(x)
    loss = F.cross_entropy(masked_logits(logits, legal), y) + F.mse_loss(value, target)
    loss.backward()
    gradient_norms = {}
    for name, parameter in model.named_parameters():
        if parameter.grad is None or not torch.isfinite(parameter.grad).all():
            raise AssertionError(f"Missing/non-finite gradient: {name}")
        gradient_norms[name] = parameter.grad.norm().item()
    for name in ("policy.conv_in.weight", "policy.head.weight", "value_head.weight"):
        if gradient_norms[name] <= 0:
            raise AssertionError(f"No learning signal: {name}")
    optimizer.step()
    if any(not torch.isfinite(p).all() for p in model.parameters()):
        raise AssertionError("Non-finite updated parameters")
    changed = [k for k, v in model.policy.state_dict().items() if not torch.equal(v, before[k])]
    if not {"conv_in.weight", "head.weight"}.issubset(changed):
        raise AssertionError("Policy parameters did not update")
    path = directory / "updated-policy.safetensors"
    model.policy.export(path)
    restored = FoldedPolicy.from_safetensors(path).cuda()
    with torch.no_grad():
        torch.testing.assert_close(restored(x), model.policy(x), atol=0, rtol=0)
    checkpoint = directory / "updated-checkpoint.pt"
    torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict()}, checkpoint)
    loaded = torch.load(checkpoint, weights_only=True)
    resumed = ActorCritic(FoldedPolicy()).cuda()
    resumed.load_state_dict(loaded["model"], strict=True)
    resumed_optimizer = torch.optim.Adam(resumed.parameters(), lr=1e-5)
    resumed_optimizer.load_state_dict(loaded["optimizer"])
    # Identical next update verifies model AND optimizer checkpoint restoration.
    for net, opt in ((model, optimizer), (resumed, resumed_optimizer)):
        opt.zero_grad(set_to_none=True)
        logits, value = net(x)
        (F.cross_entropy(masked_logits(logits, legal), y) + F.mse_loss(value, target)).backward()
        opt.step()
    for key, actual in model.state_dict().items():
        torch.testing.assert_close(actual, resumed.state_dict()[key], atol=0, rtol=0)
    return {"diagnostic_only_not_ppo": True, "loss": loss.item(),
            "warmup_preserved_policy": True, "changed_policy_tensors": changed,
            "gradient_norms": gradient_norms, "updated_export_roundtrip": True,
            "optimizer_resume_next_update_equal": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--validation-data", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=16384)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    torch.set_num_threads(4)
    torch.manual_seed(20261111)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.use_deterministic_algorithms(True)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA verification required")
    original_sha = digest(args.weights)
    spec = importlib.util.spec_from_file_location("akagi_reference", args.reference)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    x, legal, y, shards = samples(args.validation_data, args.samples)
    policy = FoldedPolicy.from_safetensors(args.weights)
    state = load_file(str(args.weights))
    cpu, cpu_report = compare(policy, state, module.folded_forward, x, legal, "cpu")
    gpu, gpu_report = compare(policy, state, module.folded_forward, x, legal, "cuda:0")
    torch.testing.assert_close(cpu, gpu, atol=2e-3, rtol=1e-5)
    cross_disagreements = int((masked_logits(cpu, legal).argmax(1) != masked_logits(gpu, legal).argmax(1)).sum())
    if cross_disagreements:
        raise AssertionError("CPU/GPU legal decisions differ")
    actor = ActorCritic(FoldedPolicy.from_safetensors(args.weights))
    if sum(p.numel() for p in actor.policy.parameters()) != 660050:
        raise AssertionError("Wrong policy parameter count")
    if sum(p.numel() for p in actor.parameters()) != 660307:
        raise AssertionError("Wrong actor-critic parameter count")
    with torch.no_grad():
        logits, values = actor(x[:256])
        torch.testing.assert_close(logits, cpu[:256], atol=0, rtol=0)
        if values.shape != (256,) or values.any():
            raise AssertionError("Invalid initial values")
    actor.train()
    with torch.no_grad():
        torch.testing.assert_close(actor(x[:256])[0], logits, atol=0, rtol=0)
    output = args.out / "01-policy.safetensors"
    actor.policy.export(output)
    reloaded = FoldedPolicy.from_safetensors(output)
    for name, tensor in state.items():
        torch.testing.assert_close(reloaded.state_dict()[name], tensor, atol=0, rtol=0)
    assert_rejected(lambda: actor.policy.export(output))
    torch.save({"model": actor.state_dict(), "geometry": GEOMETRY,
                "source_sha256": original_sha, "training_updates": 0}, args.out / "01-actor-critic.pt")
    restored = ActorCritic(FoldedPolicy())
    restored.load_state_dict(torch.load(args.out / "01-actor-critic.pt", weights_only=True)["model"], strict=True)
    for name, tensor in actor.state_dict().items():
        torch.testing.assert_close(restored.state_dict()[name], tensor, atol=0, rtol=0)
    assert_rejected(lambda: masked_logits(logits, torch.zeros_like(logits, dtype=torch.bool)))
    assert_rejected(lambda: masked_logits(logits, torch.ones_like(logits)))
    assert_rejected(lambda: masked_logits(logits, legal[:1]))
    assert_rejected(lambda: masked_logits(logits * float("nan"), legal[:256]))
    assert_rejected(lambda: actor(torch.zeros(1, 74, 34)))
    probabilities = masked_logits(logits, legal[:256]).softmax(-1)
    if probabilities[~legal[:256]].any():
        raise AssertionError("Illegal actions have positive probability")
    with tempfile.TemporaryDirectory(prefix="akagi-model-check-") as temporary:
        rejected = loading_checks(args.weights, Path(temporary))
        updates = update_check(args.weights, x, legal, y, Path(temporary))
    if digest(args.weights) != original_sha:
        raise AssertionError("Source weights changed")
    result = {"source_weights": str(args.weights), "source_sha256": original_sha,
              "reference": str(args.reference), "reference_sha256": digest(args.reference),
              "validation_samples": len(x), "validation_shards": shards,
              "sampling_seed": 20261111, "policy_parameters": 660050,
              "actor_critic_parameters": 660307, "torch": torch.__version__,
              "gpu": torch.cuda.get_device_name(), "cpu": cpu_report, "cuda": gpu_report,
              "cpu_cuda_max_error": (cpu - gpu).abs().max().item(),
              "cpu_cuda_action_disagreements": cross_disagreements,
              "rejected_weight_cases": rejected, "update_check": updates,
              "source_unchanged": True, "export_preserves_all_policy_tensors": True,
              "initial_checkpoint_updates": 0, "seconds": time.monotonic() - started}
    (args.out / "verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
