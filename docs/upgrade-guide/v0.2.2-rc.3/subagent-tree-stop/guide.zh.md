---
kind: upgrade-guide
description: "子代理资源清理失败保留为未确认状态，不再保留成功的执行结果。"
---

# 区分子代理资源清理与终态结果

[English](guide.md) | 中文

## 变更

宿主可以使用 `ctx.subagents.stopDescendants([root])` 释放当前任务的后代，之后仍从同一个 root 再次委派。`drainDescendants` 仍用于永久关闭该 root 并完成最终清理。

资源释放失败时，不再移除拥有的 activation，也不再把清理当作完成而发送结束事件。manager 按 Session 保留未确认清理，包括 factory 在交出句柄前拒绝的情况。移除或替换 root 不会清除该状态。无法确认清理时，activation 结果会拒绝，不再在 dispose 失败后保留成功的执行结果。

外部后端的强制 dispose 完成时，只收集此时可用的终态结果。资源已释放但结果仍待定或已拒绝时，停止报告 `ACTIVATION_RESULT_FAILED`。这是结果收集截止策略，不证明提供方违规；迟到结果也不会再发送一次结束事件。

## 迁移

1. 最终释放 root 前仍使用 `drainDescendants([root])`；需要保留 root 并继续委派的任务边界使用 `stopDescendants([root])`。
2. 将 `ACTIVATION_RESULT_FAILED` 诊断与清理屏障分开：该 code 确认资源已释放，不应永久阻止后续工作。未确认清理的错误必须保持可见并阻止依赖委派；不能根据目录为空或 root 已替换推断恢复。
3. 等待并处理 `activation.dispose()` 和 `activation.result`。disposer 失败或 factory 回滚未知时，替换运行时前需要资源所有者核实。重复调用一个已缓存失败的 disposer 不能证明恢复。
4. 验证正常停止后可从同一个 root 再次委派；注入清理失败后，即使替换 root，错误仍会报告，且不会产生虚假结束事件或成功结果。
