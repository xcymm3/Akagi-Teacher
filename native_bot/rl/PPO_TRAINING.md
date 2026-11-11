# 完整半庄 PPO 接入

本实现直接使用已验证的 Akagi 适配器与 RiichiEnv 0.4.11 环境，不调用上游按小局
和 GRP 分配奖励的训练路径。原源码和原 01 权重保持不变。

## 采样与奖励

- 16 个 spawn CPU worker，每 worker 4 桌，GPU 主进程集中推理；worker 在训练更新
  期间等待，不持有 GPU 模型。对手是三个冻结的 01 贪心策略，每场只有一个训练座位。
- 每批默认 128 个完整半庄，座位均衡并随迭代轮换。训练座位按合法掩码后的概率
  随机采样，温度为 1；对手和评估均使用贪心动作。训练采样回报不能直接与贪心评估混比。
- 保存训练座位的观察、合法掩码、动作、旧动作对数概率和旧价值。采样期间模型不更新；
  完成全批半庄之后才优化，不混入旧版本对局，也不采集对手动作作为训练样本。
- 半庄终局奖励为一至四位 `+2,+1,0,-3`，仅写入该座位最后一个 transition；其他
  transition 的即时奖励为 0。小局结束不切断轨迹。使用 gamma=1、GAE lambda=1，
  每个决策的价值目标等于最终顺位奖励，优势为该奖励减去旧价值。

## 初始超参数

策略学习率 1e-5，价值头学习率 1e-4，PPO clip=0.05，价值 clip=0.2，每批 2 epochs，
minibatch=512，价值损失系数 0.5，熵系数 0.001，固定 01 的精确策略 KL 系数 0.02，
每次更新的旧策略近似 KL 阈值 0.01，梯度范数上限 0.5。前 3 批仅预热价值头，
学习率 1e-3；策略主体和动作头冻结。超参数是试训起点，不代表已经最优。

`ppo_core.py` 实现 PPO clipped objective、价值裁剪、合法动作熵、参考 KL 和完整半庄
GAE；`ppo_rollout.py` 实现持久 worker 及全批采样；`train_ppo.py` 实现限时训练、
检查点、导出及评估。算法依据：[PPO 原论文](https://arxiv.org/abs/1707.06347)、
[GAE 原论文](https://arxiv.org/abs/1506.02438)。gamma=lambda=1 是本实验为终局顺位
目标选择的无折扣完整轨迹配置。

## 验证与运行

```bash
cd /disk2/Akagi/experiments/riichienv-01/code
export CUDA_VISIBLE_DEVICES=GPU-b564ea51-9c60-4f6b-1936-0178ed6e2c58
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
PY=/disk2/Akagi/env/riichienv-01/bin/python
WEIGHTS=/disk2/Akagi/experiments/runs/01-original-6m/akagi4p.safetensors
$PY -m unittest -v test_ppo test_parallel test_adapter
$PY validate_ppo.py --weights "$WEIGHTS" --out /path/new-validation
$PY train_ppo.py --weights "$WEIGHTS" --out /path/new-trial --seconds 3600 \
  --workers 16 --tables-per-worker 4 --games-per-rollout 128
```

输出目录必须不存在，权重及检查点拒绝覆盖。1 小时预算从初始基线评估结束后开始，
包含采样、价值头预热、PPO 更新、期间评估和检查点；到时完成当前完整批次后退出。
最终评估另行计时，不能将整个作业墙钟时间当作恰好 3,600 秒。

验证包括全半庄奖励传播、合法采样、裁剪损失、座位轮换、种子聚类置信区间，以及
真实环境中的预热冻结、实际策略更新、冻结对手不变、检查点恢复后下一次更新和
策略导出前向一致性。诊断权重不用于正式试训。

## 评估和保存

- 训练种子从 310000000 起；调参评估种子从 410000000 起，默认 100 个种子分别
  轮换四座，共 400 场；最终保留评估从 510000000 起，默认 200 个种子，共 800 场。
- 约每 600 秒评估一次，以平均顺位奖励选择 best，候选包含初始 01。最终同时报告
  最后一次训练策略和已选 best 的独立保留评估；不依据保留评估再选模型。
- 对战均为一个候选对三个冻结 01。记录平均顺位、四位率、平均得点及顺位奖励。
  与原 01 使用同种子同座位配对，并以四座共用的 seed 为聚类单元进行 5,000 次
  bootstrap，报告奖励、顺位、四位率差值的 95% 区间。
- `metrics.jsonl` 保存每批吞吐、累计场数/决策数、损失、熵、KL、裁剪比例和梯度；
  `training-games.jsonl` 保存逐场终局；`resource-samples.json` 每 0.2 秒记录资源，
  分 rollout/update/warmup/evaluation 汇总；`manifest.json` 固定配置及来源。
- `initial.pt`、定期 checkpoint 和 `final.pt` 保存模型、优化器、配置、NumPy/PyTorch
  RNG 和迭代/下一训练种子信息。`ppo_core.restore()` 可在批次边界恢复这些状态，
  当前 CLI 不自动续跑中断作业。异步 worker 调度会影响随机动作采样顺序，不承诺
  跨完整运行逐动作位级复现；恢复下一次优化更新已单独验证。
- `final-policy.safetensors` 为最后策略；`best-policy.safetensors` 为调参评估选中的
  策略，可能仍是初始 01。价值头不导出到 Akagi 实战策略文件。不能把训练结束或
  训练回报上升直接解释为棋力提高，结论以独立评估及其不确定性为准。
