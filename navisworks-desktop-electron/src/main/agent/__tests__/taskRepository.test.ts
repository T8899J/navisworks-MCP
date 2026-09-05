import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRepository } from '../taskRepository'
import type { CuriTask } from '../taskTypes'

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'curi-tasks-'))
}

function makeTask(overrides: Partial<CuriTask> = {}): CuriTask {
  const now = Date.now()
  return {
    id: 'task-1',
    sessionId: 'session-1',
    objective: '找出全部 Pump 中 Location 为空的构件',
    status: 'running',
    steps: [{
      id: '1',
      title: '搜索全部 Pump',
      status: 'completed',
      completionCriteria: ['搜索返回全部目标'],
      evidenceIds: ['e1'],
    }],
    completionCriteria: ['所有 Pump 已检查'],
    constraints: [],
    evidence: [{
      id: 'e1',
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'navisworks_find_items',
      status: 'supporting',
      summary: '搜索成功；返回 86 个目标；truncated=false',
      createdAt: now,
    }],
    currentStepId: '1',
    planVersion: 1,
    replanCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('TaskRepository — atomic JSON persistence', () => {
  it('saves and loads tasks round-trip', async () => {
    const directory = await makeTempDir()
    try {
      const repository = new TaskRepository(join(directory, 'tasks.json'))
      const task = makeTask()
      await repository.save([task])
      const loaded = await repository.load()
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject({ id: 'task-1', status: 'running', objective: task.objective })
      expect(loaded[0]?.evidence[0]?.summary).toContain('86')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves no temporary files behind after a save', async () => {
    const directory = await makeTempDir()
    try {
      const repository = new TaskRepository(join(directory, 'tasks.json'))
      await repository.save([makeTask()])
      await repository.save([makeTask({ id: 'task-2' })])
      const files = await readdir(directory)
      expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('falls back to the backup when the primary file is corrupt', async () => {
    const directory = await makeTempDir()
    try {
      const repository = new TaskRepository(join(directory, 'tasks.json'))
      const first = makeTask({ id: 'task-old' })
      const second = makeTask({ id: 'task-new' })
      await repository.save([first])
      await repository.save([second])
      // Simulate a torn write: primary is garbage; the backup holds the
      // PREVIOUS good state (the last write is lost, older evidence is not).
      await writeFile(join(directory, 'tasks.json'), '{"broken":', 'utf8')
      const loaded = await repository.load()
      expect(loaded.map((task) => task.id)).toEqual(['task-old'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns an empty list when neither file exists', async () => {
    const directory = await makeTempDir()
    try {
      const repository = new TaskRepository(join(directory, 'tasks.json'))
      expect(await repository.load()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('drops malformed persisted entries instead of throwing', async () => {
    const directory = await makeTempDir()
    try {
      const filePath = join(directory, 'tasks.json')
      const good = makeTask()
      await writeFile(filePath, JSON.stringify([good, { id: 42 }, 'junk', null]), 'utf8')
      const repository = new TaskRepository(filePath)
      const loaded = await repository.load()
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.id).toBe('task-1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes JSON documents that parse back as an array', async () => {
    const directory = await makeTempDir()
    try {
      const filePath = join(directory, 'tasks.json')
      const repository = new TaskRepository(filePath)
      await repository.save([makeTask()])
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      expect(Array.isArray(parsed)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
