# 上游同步 SOP（fork ← multica-ai/multica）

本仓库 `happylwp/multica` 是上游 `multica-ai/multica` 的 fork，main 分支上持有私有提交（定制改动）。本文档把每次上游同步的执行步骤固化为标准作业程序（SOP），**其中 4.7 节「迁移序号守护检查」为例行必做步骤**：每次同步合并推送之后、收尾总结之前必须执行，未通过不得宣告本轮同步完成。

- 流程基线：MARO-533（multica 上游同步 2026-11-25 实践固化）
- 守护检查：MARO-535（fork 迁移序号守护脚本，2026-11-26 固化为例行步骤，实现见 `scripts/check-fork-migration-guard.mjs`）
- 最后核对日期：2026-11-26，核对基线 `fork/main` = `61f2fc81a`（当时 784 个 migrations、fork 侧最大序号 904、上游最大序号 755、裕度 145）

## 1. 目的与适用范围

把上游 main 的新提交合并进 fork 的 main，全程不改写历史、不丢私有提交、不触碰工作区（纯 git 引用操作）。

适用：fork ← 上游的例行 main 同步（通常由同步 issue / autopilot 驱动）。不适用于功能分支的合并与发版流程。

## 2. 环境事实

| 项 | 值 |
| --- | --- |
| 本地仓库 | `/Users/liuwupeng/multica/multica`（已配好双 remote，勿重新 clone） |
| `origin` | `git@github.com:multica-ai/multica.git`（上游源项目） |
| `fork` | `git@github.com:happylwp/multica.git`（本 fork） |
| 私有提交 | fork/main 上存在本地私有提交（数量 ≥ 4），合并前必须冲突预检，绝不丢失 |

## 3. 流程总览

```text
fetch 双远端 → 统计待同步数（0 则收尾）
  → 合并前 review → git merge-tree 冲突预检（有冲突则 blocked）
  → git commit-tree 合并推送 → 推送验证
  → 迁移序号守护检查（例行必做，未通过本轮不算完成）
  → 结构化总结 + 置 done
```

## 4. 执行步骤

以下命令均可直接复制执行；除特殊说明外，全部在 `/Users/liuwupeng/multica/multica` 目录下用 Bash 完成，**不要使用编辑器改文件**。

### 4.1 同步远端引用

```bash
cd /Users/liuwupeng/multica/multica && git fetch origin main && git fetch fork main
```

若 SSH 22 端口不通（代理环境常见 `Connection closed ... port 22`），可改用 SSH over 443 的一次性 URL（不改动 remote 配置）：

```bash
git fetch ssh://git@ssh.github.com:443/multica-ai/multica.git main:refs/remotes/origin/main
git fetch ssh://git@ssh.github.com:443/happylwp/multica.git main:refs/remotes/fork/main
```

### 4.2 统计待同步提交数

```bash
git rev-list --count fork/main..origin/main
```

结果为 0：在 issue 评论「上游无新提交，无需同步」，置 `done`，结束本轮。

### 4.3 合并前 review

```bash
git log --oneline fork/main..origin/main
```

把提交清单写进 issue 评论。

### 4.4 冲突预检 + 生成合并树（纯引用操作，不触碰工作区、不切分支）

```bash
git merge-tree --write-tree --name-only fork/main origin/main
```

- 退出码 0：输出第一行为合并结果 tree OID，记为 `$TREE`，继续 4.5。
- 退出码非 0：存在冲突。**禁止合并**，在 issue 评论列出冲突文件清单与待合入改动摘要，说明需人工解决，置 `blocked`，结束本轮。

可选预检：此步可顺带运行一次 `node scripts/check-fork-migration-guard.mjs`——此刻 `fork/main` 仍是合并前状态，能提前暴露上游序号已落入保留区间的 `overlap` 信号；若此时出现重叠预警（输出含 `WILL collide`），**停止本轮同步、不要执行 4.5 合并推送**，先按 4.7 给出的映射完成 asset_profile 改号，再从 4.1 重新走流程。例行必做点仍在 4.7（合并推送之后）。

### 4.5 创建 merge commit 并推送（沿用 4.4 的 `$TREE`）

```bash
COMMIT=$(git commit-tree "$TREE" -p fork/main -p origin/main -m "Merge upstream multica-ai/multica main (sync $(date '+%Y-%m-%d %H:%M'))")
git push fork "$COMMIT:refs/heads/main"
```

SSH 22 不通时同样可用一次性 URL 推送：`git push ssh://git@ssh.github.com:443/happylwp/multica.git "$COMMIT:refs/heads/main"`。

### 4.6 推送验证

```bash
git ls-remote fork refs/heads/main   # 应指向上述 $COMMIT
git rev-list --count origin/main..fork/main   # 应 ≥ 4（确认私有提交仍在）
```

SSH 22 不通时，第一条改用一次性 URL：`git ls-remote ssh://git@ssh.github.com:443/happylwp/multica.git refs/heads/main`（用一次性 URL 推送不会更新本地 `fork/main` tracking 引用，此场景下以该命令的返回值为准）。

### 4.7 迁移序号守护检查（例行必做）

**位置：合并推送之后、总结之前。** 该检查守护的是 fork 侧缺口——上游 CI 的 `check-migration-numbers` 只护上游仓库，不护本 fork；本 fork 私有迁移 asset_profile 系列占用保留序号 900–904，上游序号逼近 900 时将发生撞号（无文本冲突、merge-tree 无法发现），必须由本步骤拦截。

先确认 `fork/main` 本地引用已指向刚推送的 `$COMMIT`（防 remote-tracking 滞后导致检查落空）：

```bash
git rev-parse fork/main   # 应等于 $COMMIT；不等则先 git fetch fork main 再跑守护脚本
```

然后运行守护脚本：

```bash
node scripts/check-fork-migration-guard.mjs
# 等价默认参数：--ref fork/main --upstream origin/main --margin 20
```

处置规则（退出码：0=通过 / 1=撞号 / 2=无法运行；预警分两类——**裕度预警**仅裕度低于阈值，**重叠预警**为上游序号已实际落入保留区间，输出含 `WILL collide`）：

| 退出码 | 含义 | 处置 |
| --- | --- | --- |
| 0 且无预警 | ≥129 序号零重复、裕度充足 | 通过，进入 4.8 收尾 |
| 0 且裕度预警 | 零重复，但上游最大序号距保留区间下界（900）裕度低于阈值 | 通过，**但总结必须记录预警原文与 asset_profile 改号评估结论**（见下） |
| 0 且重叠预警 | 上游序号已实际落入保留区间 [900, 904]，下次同步必然撞号 | **本轮同步不算完成**：置 `blocked`，按脚本给出的映射立即安排 asset_profile 改号，改号合入后重跑本检查；不存在「暂不改号」选项 |
| 1 | ≥129 存在撞号 | 在 issue 评论列出冲突序号与全部冲突文件，置 `blocked`，**本轮同步不算完成**，按脚本给出的改号建议修复后重新走检查 |
| 2 | 无法运行（引用读不到 / 迁移目录为空 / 阈值非法） | 通常是 4.1 的 fetch 未完成；修复后重跑，不得跳过 |

裕度预警时的记录要求：把脚本输出的预警原文（含上游最大序号、裕度值、阈值）与 asset_profile 改号评估结论写入 4.8 的同步总结。评估结论至少回答两点：是否采纳脚本给出的改号映射（目标序号自 `max(forkMax, upstreamMax)+1` 连续分配，如当前 900→905 … 904→909）；若暂不改号，计划的改号时机（下一次裕度复查或上游最大序号到达某一数值前）。**「暂不改号」仅适用于裕度预警**；重叠预警必须改号，见上表。

输出样例（2026-11-26 在 `fork/main` = `61f2fc81a` 实测）：

```text
# 通过（退出码 0，当前默认阈值 20 不触发预警）
Migration numbers >= 129 are unique on fork/main (784 migrations, max 904).

# 裕度预警（仍退出码 0；以 --margin 150 演示，默认阈值 20）
Upstream migration max on origin/main is 755; headroom to the reserved floor 900 is 145 (threshold 150).
Renumber the reserved series as follows before the next upstream sync:
  900_asset_profile: 900 -> 905
  901_asset_profile_id_uidx: 901 -> 906
  902_asset_profile_pkey: 902 -> 907
  903_asset_profile_workspace_idx: 903 -> 908
  904_asset_profile_workspace_name_uidx: 904 -> 909

# 撞号（退出码 1；负向样本示例。冲突行带两个前导空格，其后为 stderr 提示块）
  Migration number 902 is used by 2 migrations on fork/main: 902_asset_profile_pkey, 902_dup_demo

1 migration number(s) collide on fork/main.
Rename both the .up.sql and .down.sql files (and any references to the
version, such as concurrent index cleanups in server/cmd/migrate/main.go).
```

判定语义（与上游 `check-migration-numbers.mjs`、`server/internal/migrations/` 下 `TestMigrationNumericPrefixesAreUnique` 一致，契约来源 `FIRST_UNIQUE_MIGRATION_NUMBER = 129`）：版本键为文件名 stem（`server/migrations/` 下 `.up.sql` 文件名去掉后缀），up/down 一对计一次；≤128 的同号多 stem 系上游历史遗留豁免，不算重复。上游序号跳号越过保留区间不误报，只有实际落入 [900, 904] 才判「下次同步 WILL collide」。

其他用法（按需）：

```bash
node scripts/check-fork-migration-guard.mjs --json                 # 结构化输出（duplicates + headroom）
node scripts/check-fork-migration-guard.mjs --ref <分支> --upstream <引用>   # 自定义引用（如待合并任务分支）
```

### 4.8 结构化总结与收尾

在 issue 评论留结构化总结，至少包含：合入提交数与清单、merge commit OID、推送与验证结果、**守护检查结论**（4.7 的输出摘要；有裕度预警时附预警原文与改号评估结论）；置 `done`。

## 5. 安全红线（沿用 MARO-533）

- 只允许向 fork 的 `main` 分支推送；禁止 force push；禁止 rebase / 改写 fork/main 历史
- 禁止以任何方式丢弃或覆盖 fork/main 上的私有提交
- 冲突时禁止手工编辑文件强行合并，直接报告并置 `blocked`
- 同步全程不得 checkout / 切换该仓库的工作区分支，不得改动工作区文件（守护检查等命令均为纯读取）
- 未跟踪的本地文件（如 `apps/web/AGENTS.md`、`apps/web/CLAUDE.md`、`portfolio-baseline-20261023.md`）保留勿动
- 禁止终止 `multica` / `multica.exe` 进程

## 6. 同步 issue 编写要求

凡新开上游同步 issue（含 autopilot 定时生成的同步任务），其「执行步骤」必须包含与 4.7 等价的守护检查步骤（合并推送之后、总结之前运行 `node scripts/check-fork-migration-guard.mjs`，并写明退出码处置规则），不得省略。建议直接引用本文档（`docs/upstream-sync.md`）作为步骤来源。
