//! candle CNN inference. Architecture mirrors `train/train.py` **after** its
//! BatchNorm-folding export, so this side is pure Conv1d + Linear (no BN op).
//!
//! Weights are loaded from a `.safetensors` buffer whose keys are:
//! `conv_in.{weight,bias}`, `res.{i}.conv{1,2}.{weight,bias}`,
//! `fc.{weight,bias}`, `head.{weight,bias}`.

use candle_core::{Device, Result, Tensor};
use candle_nn::{conv1d, linear, Conv1d, Conv1dConfig, Linear, Module, VarBuilder};

use crate::Geometry;

/// Read dimensions from the tensors so four-player and three-player models
/// can use different widths and depths without changing their input encoding.
fn architecture(bytes: &[u8], geo: Geometry) -> Result<(usize, usize, usize)> {
    let tensors = safetensors::SafeTensors::deserialize(bytes).map_err(candle_core::Error::wrap)?;
    let input = tensors
        .tensor("conv_in.weight")
        .map_err(candle_core::Error::wrap)?;
    let fc = tensors
        .tensor("fc.weight")
        .map_err(candle_core::Error::wrap)?;
    let head = tensors
        .tensor("head.weight")
        .map_err(candle_core::Error::wrap)?;
    let input = input.shape();
    let fc = fc.shape();
    let head = head.shape();
    if input.len() != 3 || input[0] == 0 || input[1] != geo.channels || input[2] != 3 {
        candle_core::bail!("invalid input convolution shape: {input:?}");
    }
    let width = input[0];
    if fc.len() != 2 || fc[0] == 0 || fc[1] != width * geo.tile_dim {
        candle_core::bail!("invalid fully connected shape: {fc:?}");
    }
    if head != [geo.action_space, fc[0]] {
        candle_core::bail!("invalid action head shape: {head:?}");
    }
    let names = tensors.names();
    let blocks = names
        .iter()
        .filter(|name| name.starts_with("res.") && name.ends_with(".conv1.weight"))
        .count();
    // Validate every residual tensor and reject gaps rather than silently
    // dropping blocks when loading a differently sized checkpoint.
    for i in 0..blocks {
        for layer in ["conv1", "conv2"] {
            let name = format!("res.{i}.{layer}.weight");
            let tensor = tensors.tensor(&name).map_err(candle_core::Error::wrap)?;
            if tensor.shape() != [width, width, 3] {
                candle_core::bail!("invalid residual convolution shape: {name}");
            }
        }
    }
    if names.len() != 6 + 4 * blocks {
        candle_core::bail!("unexpected tensor count in folded model: {}", names.len());
    }
    Ok((width, blocks, fc[0]))
}

pub struct Model {
    conv_in: Conv1d,
    res: Vec<(Conv1d, Conv1d)>,
    fc: Linear,
    head: Linear,
    geo: Geometry,
}

impl Model {
    /// Build the model for `num_players` from a safetensors byte buffer.
    pub fn from_safetensors(bytes: Vec<u8>, num_players: u8) -> Result<Self> {
        let dev = Device::Cpu;
        let geo = Geometry::for_players(num_players);
        let (width, blocks, fc_dim) = architecture(&bytes, geo)?;
        let vb = VarBuilder::from_buffered_safetensors(bytes, candle_core::DType::F32, &dev)?;
        let cfg = Conv1dConfig {
            padding: 1,
            ..Default::default()
        };

        let conv_in = conv1d(geo.channels, width, 3, cfg, vb.pp("conv_in"))?;
        let mut res = Vec::with_capacity(blocks);
        for i in 0..blocks {
            let b = vb.pp(format!("res.{i}"));
            let c1 = conv1d(width, width, 3, cfg, b.pp("conv1"))?;
            let c2 = conv1d(width, width, 3, cfg, b.pp("conv2"))?;
            res.push((c1, c2));
        }
        let fc = linear(width * geo.tile_dim, fc_dim, vb.pp("fc"))?;
        let head = linear(fc_dim, geo.action_space, vb.pp("head"))?;

        Ok(Self {
            conv_in,
            res,
            fc,
            head,
            geo,
        })
    }

    pub fn geometry(&self) -> Geometry {
        self.geo
    }

    /// Forward one flattened `[C*T]` observation to action logits `[A]`.
    pub fn forward_logits(&self, obs: &[f32]) -> Result<Vec<f32>> {
        let dev = Device::Cpu;
        let x = Tensor::from_vec(
            obs.to_vec(),
            (1, self.geo.channels, self.geo.tile_dim),
            &dev,
        )?;
        let mut x = self.conv_in.forward(&x)?.relu()?;
        for (c1, c2) in &self.res {
            let y = c1.forward(&x)?.relu()?;
            let y = c2.forward(&y)?;
            x = y.add(&x)?.relu()?;
        }
        let x = x.flatten_from(1)?;
        let x = self.fc.forward(&x)?.relu()?;
        let logits = self.head.forward(&x)?;
        logits.squeeze(0)?.to_vec1::<f32>()
    }
}
