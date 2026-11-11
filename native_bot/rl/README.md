# 01 模型迁移与 RiichiEnv 适配

本目录完成接入计划的阶段 1–3：独立环境、可训练模型迁移，以及 Akagi 观察、
动作和事件适配。阶段 3 已完成小规模对战及差分验证，尚未进行正式并发测速、
大规模稳定性验证或 PPO 训练。阶段结果分别见 `STAGE12_RESULTS.md` 和 `STAGE3_RESULTS.md`。

## 环境适配（阶段 3）

`adapter.py` 仅接收各座位的 `Observation`，不读取全局环境或其他玩家隐藏手牌。
`bridge/` 是对原 `native_bot` 的薄 Rust/PyO3 封装：固定 `riichienv-core = 0.4.8`，
直接复用 `obs`、`adapt`、`mjai_compat`、`chankan` 和 `action_codec`，避免 Python 重写漂移。
模拟器仍使用 RiichiEnv 0.4.11。

```bash
bash /disk2/Akagi/experiments/riichienv-01/code/build_bridge.sh
cd /disk2/Akagi/experiments/riichienv-01/code
/disk2/Akagi/env/riichienv-01/bin/python -m unittest -v test_adapter
```

构建脚本使用固定原源码提交和 Cargo.lock，生成目录独立于源码；不修改或升级两个
上游源码仓库。`build_bridge.sh` 面向交接中的服务器布局。直接在完整源码仓库构建时，
`bridge/Cargo.toml` 的相对依赖路径指向同仓库的 `native_bot`。

```python
from riichienv import RiichiEnv, GameRule
from adapter import AkagiAgent, terminal_rewards
from model import FoldedPolicy

policy = FoldedPolicy.from_safetensors("/path/to/01/akagi4p.safetensors").eval()
env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou(), seed=123)
agents = {seat: AkagiAgent(policy, seat) for seat in range(4)}
observations = env.reset()
while not env.done():
    actions = {seat: agents[seat].act(obs) for seat, obs in observations.items()}
    observations = env.step(actions)
rewards = terminal_rewards(list(env.ranks()))
```

一至四位的终局奖励固定为 **`+2、+1、0、−3`**；输入为环境的一基排名，返回绝对座位
顺序的奖励。该辅助函数已验证；PPO 的回报/优势链路尚未接入，不代表奖励已经进入训练。

训练侧可直接使用 `AkagiAdapter.prepare(obs)` 获得 `features[39,34]`、布尔
`legal_mask[82]` 和 `resolve(action_id)`。非法编号直接报错。一个编号可能对应多个
实体动作，按原 codec 去重，普通五优先于赤五舍牌，其他碰吃组合保留环境枚举的首项。
立直和立直后舍牌是两个环境决策，动作只通过 `env.step()` 后回传的事件更新状态。

每个座位使用独立适配器。`prepare` 对同一个 Observation 对象的重复调用幂等；
外部必须按环境产生顺序、每个观察一次地交付增量事件，不得先用其他消费者取走环境
事件窗口。新对局重建适配器或调用 `reset()`；发生事件异常后必须重置。
不支持关闭 MJAI 日志的环境（缺失事件会报错）。

默认特征合同是 `akagi-mjai-0.4.8-raw-v1`，与 Akagi 实时推理一样使用原始 float32。
需要与监督训练分片比较时，使用 `quantized_features()`，其 Rust 四舍五入规则与提取器
一致；不可默默将默认推理输入改成量化输入。

旧回放引擎的回合计数和立直宣言牌通道保留原语义；它在规则判定上存在已知旧行为，
因此**绝不使用旧回放引擎生成训练合法集合**。合法集合只来自当前 RiichiEnv Observation，
再用原 codec 编号；“后续巡误给九种九牌”的真实案例已加入回归测试。
更多版本差异和信息边界见阶段 3 验收报告。

独立 Rust 全前缀回放对照及小规模对战验证命令（输出目录必须不存在）：

```bash
CUDA_VISIBLE_DEVICES=GPU-b564ea51-9c60-4f6b-1936-0178ed6e2c58 \
/disk2/Akagi/env/riichienv-01/bin/python validate_adapter.py \
  --weights /disk2/Akagi/experiments/runs/01-original-6m/akagi4p.safetensors \
  --oracle /disk2/Akagi/env/akagi-bridge-target/release/reference \
  --out /disk2/Akagi/experiments/riichienv-01/stage3/new-verification --games 20
```

## 模型

`model.py` 保留 `39×34` 输入、64 通道、3 个残差块、256 维全连接和 82 动作头。
策略参数为 660,050，添加价值头后为 660,307。价值头零初始化；后续 PPO 应先
预热价值头，再联合训练。加载器拒绝缺失或额外参数、形状错误、非 FP32、非有限
权重以及不兼容的已声明元数据。权重缺少元数据时仍严格验证全部参数结构。

```python
from model import ActorCritic, FoldedPolicy, masked_logits

policy = FoldedPolicy.from_safetensors("/path/to/01/akagi4p.safetensors")
model = ActorCritic(policy)
logits, values = model(akagi_observations)  # [B,39,34], 已按 Akagi 规范编码
distribution_logits = masked_logits(logits, legal_mask)  # bool [B,82]
model.policy.export("/new/path/policy.safetensors")
```

非法动作掩码、没有合法动作或非有限 logits 会报错；不会替换为默认动作。
导出仅包含策略权重和 Akagi 元数据，拒绝覆盖已有文件。

## 服务器安装与复现

默认根目录 `/disk2/Akagi`，可通过 `AKAGI_ROOT` 指定。

- 原 Python 环境：`env/py312-cu128`，只读核验。
- 新 Python 环境：`env/riichienv-01`，不共享原环境 site-packages。
- RiichiEnv 源码：`RiichiEnv`，固定提交
  `0ee1236a283b15508f3ac28407027f340b81e1de`（0.4.11）。
- 安装缓存：复用已有 wheelhouse，构建 wheel 存入 `env/riichienv-wheels`。
- Rust 构建输出：独立的 `env/riichienv-cargo-target`。
- 结果目录：`experiments/riichienv-01/stage12`。

将本目录脚本放到服务器的 `experiments/riichienv-01/code`，执行：

```bash
bash /disk2/Akagi/experiments/riichienv-01/code/setup_stage12.sh
bash /disk2/Akagi/experiments/riichienv-01/code/verify_stage12.sh
```

安装默认拒绝替换已有环境。如果本次安装中断，可明确使用
`setup_stage12.sh --resume` 继续，保留最初的原环境和原权重快照。
脚本使用现有独立 Rust 编译器，并记录实际版本；不自动安装或切换系统 Rust。
`maturin build --locked` 使用源码的 Cargo.lock。
服务器缺少 ensurepip 时，从 pip wheel 引导新环境，不需要 sudo。
本阶段仅安装模拟器和模型验证依赖，`riichienv-ml` 的 PPO 依赖在接入训练时处理。
完整 Python 版本列表保存在结果目录的 `requirements.freeze.txt`。

验证脚本将 CUDA 设备固定到第二张物理 GPU 的 UUID；在该进程内编号为 `cuda:0`。
开始前应检查该 GPU 是否仍空闲。输出目录必须为新目录，已有验收结果不会覆盖。
重新验证时，可以直接运行两个 Python 脚本并指定新的 `--out`。

## 验证范围

`smoke_env.py` 使用随机合法策略完成 10 个天凤规则四人赤牌半庄，并重复第一个
种子检查确定性。它验证模拟器基础可用性，不能证明 Akagi 观察/动作适配兼容。

`validate_model.py` 从 96 个验证分片分层随机抽取共 16,384 条样本，不访问测试集。
参考前向来自服务器原源码 `native_bot/train/parity_check.py`，运行时记录其 SHA256。

检查项目：

- CPU/GPU 分别与原函数式 PyTorch 前向比较，容差 `atol=1e-5, rtol=1e-5`。
- CPU 与 GPU、单样本与批量比较，容差 `atol=2e-3, rtol=1e-5`，合法动作必须一致。
- 策略参数、训练/评估模式、零初始化价值输出、导出和初始检查点重载。
- 错误权重、错误观察形状和错误合法动作掩码拒绝行为。
- 冻结策略后仅预热价值头，确认策略参数不变。
- 一次监督损失与合成价值目标的诊断更新，检查梯度及策略参数变化。
- 更新后临时导出一致性、模型和 Adam 状态恢复后的下一步更新完全一致。
- 原始权重 SHA256、原环境依赖列表保持不变。

诊断更新只存在于内存和临时目录，不代表 PPO 学习，也不作为新策略交付。
持久保存的 `01-policy.safetensors` 和 `01-actor-critic.pt` 均保持初始策略，训练更新数为 0。
没有在本阶段执行 Rust candle 前向比较；导出保留其预期的名称、形状和原始张量。
上面的验证项目描述阶段 2；阶段 3 已添加环境适配验证，最终策略导出后的 Rust 推理回接仍属于后续阶段。
