import { renderTaskContext } from '../../agent/taskContext'
import { canonicalFingerprint } from '../contextHash'
import type { ContextSource } from '../types'

/** Volatile: the active task block, recomputed every run, never durable. */
export const taskSource: ContextSource<string> = {
  key: 'task/state',
  version: 1,
  mode: 'volatile',
  load(env) {
    const task = env.activeTask
    if (task === undefined) return undefined
    return renderTaskContext(task, env.taskVerification)
  },
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => value,
}
