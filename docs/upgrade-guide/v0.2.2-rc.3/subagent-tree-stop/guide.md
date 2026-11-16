---
kind: upgrade-guide
description: "Subagent cleanup failures remain unverified instead of preserving a successful execution result."
---

# Separate subagent resource cleanup from terminal results

English | [中文](guide.zh.md)

## Change

Subagent hosts can use `ctx.subagents.stopDescendants([root])` to release a task's current descendants and then delegate again from the same root. `drainDescendants` still permanently closes that root for teardown.

Failed resource release no longer removes the owned activation or emits an end event as though cleanup completed. The manager retains unverified cleanup by Session, including factory rejection before a handle was handed over. Removing or replacing the root does not clear this state. The activation result rejects when cleanup cannot be confirmed, rather than retaining a successful execution result after failed disposal.

Forced external disposal collects the terminal result available when disposal completes. If resources were released but the result is pending or rejected, stopping reports `ACTIVATION_RESULT_FAILED`. This is a result-collection cutoff, not proof of a provider violation. Late results do not publish another end.

## Migration

1. Keep `drainDescendants([root])` before final root disposal. Use `stopDescendants([root])` for task boundaries that preserve the root and later delegation.
2. Separate `ACTIVATION_RESULT_FAILED` diagnostics from cleanup barriers: that code confirms release, so it must not permanently block later work. Keep errors for unverified cleanup visible and stop dependent delegation; do not infer recovery from an empty catalog or a replacement root.
3. Await and handle both `activation.dispose()` and `activation.result`. A failed disposer or unknown factory rollback requires the resource owner's verification before replacing the runtime. Repeating a memoized failed disposer does not establish recovery.
4. Verify a normal stopped tree can delegate again on the same root, and that injected cleanup failure remains reported across root replacement without a false end or successful result.
