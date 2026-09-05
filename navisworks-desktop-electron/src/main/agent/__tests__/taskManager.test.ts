import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from '../taskManager'
import { TaskRepository } from '../taskRepository'
import type { CuriTask } from '../taskTypes'

async function makeTempPaths(): Promise<{ file: string; backup: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'curi-task-mgr-'))
  return {
    file: join(directory, 'tasks.json'),
    backup: join(directory, 'tasks.backup.json'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

async function createRunningTask(manager: TaskManager, sessionId = 'session-1'): Promise<CuriTask> {
  const task = await manager.createTask({
    sessionId,
    objective: '找出全部 Pump 中 Location 为空的构件',
    constraints: ['不要修改模型'],
    completionCriteria: ['所有 Pump 已检查', '空 Location 项均有名称'],
    steps: [
      { title: '搜索全部 Pump', completionCriteria: ['目标搜索结果完整'] },
      { title: '读取 Location', completionCriteria: ['所有目标均已读取 Location 属性'] },
      { title: '汇总结果', completionCriteria: ['异常项均有构件名称'] },
    ],
  })
  return manager.markRunning(task.id)
}

describe('TaskManager — lifecycle', () => {
  it('creates a planning task with numbered steps, then runs it', async () => {
    const manager = new TaskManager()
    const task = await manager.createTask({
      sessionId: 'session-1',
      objective: '检查 Location',
      steps: [
        { title: '搜索', completionCriteria: ['结果完整'] },
        { title: '读取', description: '读取 Location 属性', completionCriteria: ['全部读取'] },
      ],
    })
    expect(task.status).toBe('planning')
    expect(task.planVersion).toBe(1)
    expect(task.replanCount).toBe(0)
    expect(task.steps.map((step) => step.id)).toEqual(['1', '2'])
    expect(task.steps[1]?.description).toBe('读取 Location 属性')

    const running = await manager.markRunning(task.id)
    expect(running.status).toBe('running')
    expect(running.currentStepId).toBe('1')
  })

  it('runs the full lifecycle: running → blocked → running → completed', async () => {
    const manager = new TaskManager()
    const task = await createRunningTask(manager)
    await manager.recordToolEvidence(task.id, {
      toolCallId: 'call-1',
      toolName: 'navisworks_find_items',
      status: 'supporting',
      summary: '搜索成功；返回 86 个目标；truncated=false',
    })

    const blocked = await manager.block(task.id, 'NAV_DISCONNECTED')
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('NAV_DISCONNECTED')

    const resumed = await manager.markRunning(task.id)
    expect(resumed.status).toBe('running')
    expect(resumed.blockedReason).toBeUndefined()
    expect(resumed.evidence).toHaveLength(1)
    expect(resumed.evidence[0]?.id).toBe('e1')

    const completed = await manager.complete(task.id)
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toBeTypeOf('number')
  })

  it('pauses with a reason and resumes cleanly', async () => {
    const manager = new TaskManager()
    const task = await createRunningTask(manager)
    const paused = await manager.pause(task.id, 'USER_ABORTED')
    expect(paused.status).toBe('paused')
    expect(paused.pauseReason).toBe('USER_ABORTED')
    const resumed = await manager.markRunning(task.id)
    expect(resumed.status).toBe('running')
    expect(resumed.pauseReason).toBeUndefined()
  })

  it('rejects illegal transitions', async () => {
    const manager = new TaskManager()
    const task = await createRunningTask(manager)
    const completed = await manager.complete(task.id)

    await expect(manager.markRunning(completed.id)).rejects.toThrow(/Invalid task transition/)
    // Completed is terminal: it can neither resume nor be cancelled.
    await expect(manager.cancel(completed.id)).rejects.toThrow(/Invalid task transition/)

    const secondTask = await createRunningTask(manager)
    const cancelled = await manager.cancel(secondTask.id)
    expect(cancelled.status).toBe('cancelled')
    await expect(manager.markRunning(cancelled.id)).rejects.toThrow(/Invalid task transition/)
    await expect(manager.pause(cancelled.id, 'MODEL_ERROR')).rejects.toThrow(/Invalid task transition/)
  })

  it('only finds resumable tasks, latest first per session', async () => {
    const manager = new TaskManager()
    const old = await createRunningTask(manager, 'session-1')
    // Ensure strictly newer updatedAt for the second task (same-ms writes tie).
    await new Promise((resolve) => setTimeout(resolve, 2))
    const current = await manager.createTask({
      sessionId: 'session-1',
      objective: '第二个任务',
      steps: [{ title: '步骤', completionCriteria: ['c'] }],
    })
    // `current` was created later so its updatedAt is the newest.
    const resumable = manager.getResumableTaskForSession('session-1')
    expect(resumable?.id).toBe(current.id)

    await manager.complete(old.id)
    await manager.pause(current.id, 'MODEL_ERROR')
    expect(manager.getResumableTaskForSession('session-1')?.status).toBe('paused')

    const otherSession = await createRunningTask(manager, 'session-2')
    await manager.cancel(otherSession.id)
    expect(manager.getResumableTaskForSession('session-2')).toBeUndefined()
  })

  it('deletes every task of a session and nothing else', async () => {
    const manager = new TaskManager()
    await createRunningTask(manager, 'session-1')
    const keep = await createRunningTask(manager, 'session-2')
    await manager.deleteBySession('session-1')
    expect(manager.all().map((task) => task.id)).toEqual([keep.id])
  })
})

describe('TaskManager — evidence and verification', () => {
  it('records tool evidence with stable short ids', async () => {
    const manager = new TaskManager()
    const task = await createRunningTask(manager)
    await manager.recordToolEvidence(task.id, {
      toolCallId: 'call-1', toolName: 'navisworks_find_items', status: 'supporting',
      summary: '搜索成功；返回 86 个目标',
    })
    const updated = await manager.recordToolEvidence(task.id, {
      toolCallId: 'call-2', toolName: 'navisworks_get_item_properties', status: 'contradicting',
      summary: '失败 BRIDGE_IO：写入超时',
    })
    expect(updated.evidence.map((entry) => entry.id)).toEqual(['e1', 'e2'])
    expect(updated.evidence[1]?.toolCallId).toBe('call-2')
    expect(updated.evidence[1]?.type).toBe('tool-result')
  })

  it('applies verification: step updates, evidence links, verdict evidence', async () => {
    const manager = new TaskManager()
    const task = await createRunningTask(manager)
    await manager.recordToolEvidence(task.id, {
      toolCallId: 'call-1', toolName: 'navisworks_find_items', status: 'supporting',
      summary: '搜索成功；返回 86 个目标',
    })
    await manager.recordToolEvidence(task.id, {
      toolCallId: 'call-2', toolName: 'navisworks_get_item_properties', status: 'supporting',
      summary: '已读取 40 个对象的属性',
    })

    const applied = await manager.applyVerification(task.id, {
      verdict: 'continue',
      reason: '还有 48 个构件没有读取 Location',
      stepUpdates: [
        { stepId: '1', status: 'completed', evidenceIds: ['e1'] },
        { stepId: '2', status: 'active', evidenceIds: ['e2', 'e99'] },
      ],
      missingEvidence: ['还有 48 个构件没有读取 Location'],
      nextAction: '继续读取剩余对象',
    })
    expect(applied.steps[0]?.status).toBe('completed')
    expect(applied.steps[0]?.evidenceIds).toEqual(['e1'])
    // Unknown evidence ids are dropped, known ones linked.
    expect(applied.steps[1]?.status).toBe('active')
    expect(applied.steps[1]?.evidenceIds).toEqual(['e2'])
    // The verdict itself became evidence.
    expect(applied.evidence[2]?.type).toBe('verification')
    expect(applied.evidence[2]?.summary).toContain('还有 48 个构件没有读取 Location')
    expect(applied.currentStepId).toBe('2')
  })

  it('replacePlan bumps planVersion/replanCount and keeps old evidence', async () => {
    const manager = new TaskManager()
    const task = await createRunningTask(manager)
    await manager.recordToolEvidence(task.id, {
      toolCallId: 'call-1', toolName: 'navisworks_find_items', status: 'contradicting',
      summary: '按名称搜索结果不完整',
    })

    const replanned = await manager.replacePlan(task.id, {
      completionCriteria: ['按类别搜索的结果集完整', '所有目标已读取 Location'],
      steps: [
        { title: '按类别重新搜索', completionCriteria: ['结果集完整'] },
        { title: '读取 Location', completionCriteria: ['全部读取'] },
      ],
    })
    expect(replanned.planVersion).toBe(2)
    expect(replanned.replanCount).toBe(1)
    expect(replanned.steps.map((step) => step.title)).toEqual(['按类别重新搜索', '读取 Location'])
    expect(replanned.steps[0]?.status).toBe('pending')
    expect(replanned.evidence).toHaveLength(1)
    expect(replanned.completionCriteria).toContain('按类别搜索的结果集完整')
    expect(replanned.currentStepId).toBe('1')
  })
})

describe('TaskManager — persistence and crash recovery', () => {
  it('persists every mutation and reloads from disk', async () => {
    const paths = await makeTempPaths()
    try {
      const manager = new TaskManager(new TaskRepository(paths.file, paths.backup))
      const task = await createRunningTask(manager)
      await manager.recordToolEvidence(task.id, {
        toolCallId: 'call-1', toolName: 'navisworks_find_items', status: 'supporting',
        summary: '搜索成功',
      })

      const reloaded = new TaskManager(new TaskRepository(paths.file, paths.backup))
      await reloaded.initialize()
      expect(reloaded.getTask(task.id)?.evidence).toHaveLength(1)
    } finally {
      await paths.cleanup()
    }
  })

  it('recovers planning/running tasks as paused PROCESS_INTERRUPTED, never auto-runs', async () => {
    const paths = await makeTempPaths()
    try {
      const manager = new TaskManager(new TaskRepository(paths.file, paths.backup))
      const running = await createRunningTask(manager, 'session-1')
      const planning = await manager.createTask({
        sessionId: 'session-2',
        objective: '另一件事',
        steps: [{ title: '步骤', completionCriteria: ['c'] }],
      })
      const doneTask = await createRunningTask(manager, 'session-3')
      const done = await manager.complete(doneTask.id)

      // Simulate a restart: a fresh manager reads what the old one persisted.
      const restarted = new TaskManager(new TaskRepository(paths.file, paths.backup))
      await restarted.initialize()
      const recoveredRunning = restarted.getTask(running.id)
      expect(recoveredRunning?.status).toBe('paused')
      expect(recoveredRunning?.pauseReason).toBe('PROCESS_INTERRUPTED')
      expect(restarted.getTask(planning.id)?.status).toBe('paused')
      // Terminal states are untouched.
      expect(restarted.getTask(done.id)?.status).toBe('completed')
    } finally {
      await paths.cleanup()
    }
  })
})
