"""Trainable four-player Akagi policy using already-folded BatchNorm weights.

This module does not encode RiichiEnv observations or map environment actions.
Inputs must already use Akagi's 39 x 34 encoding and 82-action legal mask.
"""
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import load_file, save
from torch import nn
from torch.nn import functional as F


GEOMETRY = {
    "num_players": "4", "channels": "39", "tile_dim": "34",
    "action_space": "82", "conv": "64", "blocks": "3", "fc": "256",
    "obs_scale": "4.0",
}


class FoldedResidual(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv1d(64, 64, 3, padding=1, bias=True)
        self.conv2 = nn.Conv1d(64, 64, 3, padding=1, bias=True)

    def forward(self, x):
        return F.relu(x + self.conv2(F.relu(self.conv1(x))))


class FoldedPolicy(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_in = nn.Conv1d(39, 64, 3, padding=1, bias=True)
        self.res = nn.ModuleList([FoldedResidual() for _ in range(3)])
        self.fc = nn.Linear(64 * 34, 256)
        self.head = nn.Linear(256, 82)

    def features(self, x):
        if x.ndim != 3 or tuple(x.shape[1:]) != (39, 34):
            raise ValueError("Expected observations shaped [batch, 39, 34]")
        x = F.relu(self.conv_in(x))
        for block in self.res:
            x = block(x)
        return F.relu(self.fc(x.flatten(1)))

    def forward(self, x):
        return self.head(self.features(x))

    @classmethod
    def from_safetensors(cls, path):
        with safe_open(str(path), framework="pt", device="cpu") as source:
            metadata = source.metadata() or {}
        for name, expected in GEOMETRY.items():
            if name in metadata and metadata[name] != expected:
                raise ValueError(f"Incompatible metadata {name}: {metadata[name]}")
        model = cls()
        state = load_file(str(path), device="cpu")
        expected = model.state_dict()
        if state.keys() != expected.keys():
            raise ValueError(
                f"Weight keys differ: missing={sorted(expected.keys() - state.keys())}, "
                f"unexpected={sorted(state.keys() - expected.keys())}"
            )
        for name, tensor in state.items():
            if tensor.shape != expected[name].shape or tensor.dtype != torch.float32:
                raise ValueError(f"Invalid weight shape or dtype: {name}")
            if not torch.isfinite(tensor).all():
                raise ValueError(f"Non-finite weight: {name}")
        model.load_state_dict(state, strict=True)
        return model

    def export(self, path):
        """Write policy-only FP32 weights; never overwrite an existing artifact."""
        state = {k: v.detach().cpu().contiguous() for k, v in self.state_dict().items()}
        if any(v.dtype != torch.float32 or not torch.isfinite(v).all() for v in state.values()):
            raise ValueError("Export requires finite FP32 weights")
        payload = save(state, metadata=GEOMETRY)
        with Path(path).open("xb") as output:
            output.write(payload)


class ActorCritic(nn.Module):
    def __init__(self, policy):
        super().__init__()
        self.policy = policy
        self.value_head = nn.Linear(256, 1)
        # Neutral initial values; warm up this head before joint PPO training.
        nn.init.zeros_(self.value_head.weight)
        nn.init.zeros_(self.value_head.bias)

    def forward(self, x):
        features = self.policy.features(x)
        return self.policy.head(features), self.value_head(features).squeeze(-1)


def masked_logits(logits, legal):
    if logits.ndim != 2 or logits.shape[1] != 82:
        raise ValueError("Expected logits shaped [batch, 82]")
    if legal.dtype != torch.bool or legal.shape != logits.shape or legal.device != logits.device:
        raise ValueError("Legal mask must be bool and match logits shape/device")
    if not legal.any(dim=-1).all():
        raise ValueError("Every observation must have at least one legal action")
    if not torch.isfinite(logits).all():
        raise ValueError("Non-finite policy logits")
    return logits.masked_fill(~legal, float("-inf"))
