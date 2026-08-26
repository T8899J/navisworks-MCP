import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_SETTINGS,
  JsonSessionRepository,
  JsonSettingsRepository,
  type AppSettings,
  type ConversationSession,
} from '../sessionRepository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('WPF-compatible JSON repositories', () => {
  it('falls back to backup without overwriting the damaged primary', async () => {
    const paths = await createPaths()
    const snapshot = [{
      Id: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
      Title: '测试会话',
      Preview: '测试预览',
      UpdatedAt: '2026-01-15T08:30:00+08:00',
      Messages: [{ Role: 'user', Content: '你好', IsTransient: false, ThinkingText: '' }],
      ContextTokensUsed: 32,
      PinnedAt: null,
    }]
    await writeFile(paths.sessionsFile, '{ invalid json', 'utf8')
    await writeFile(paths.sessionsBackupFile, JSON.stringify(snapshot), 'utf8')

    const repository = new JsonSessionRepository(paths)
    const result = await repository.load()

    expect(result.source).toBe('backup')
    expect(result.canPersist).toBe(true)
    expect(result.sessions[0]?.messages?.[0]?.content).toBe('你好')
    expect(await readFile(paths.sessionsFile, 'utf8')).toBe('{ invalid json')
  })

  it('disables persistence when both session files are unreadable', async () => {
    const paths = await createPaths()
    await writeFile(paths.sessionsFile, 'not-json-primary', 'utf8')
    await writeFile(paths.sessionsBackupFile, 'not-json-backup', 'utf8')

    const result = await new JsonSessionRepository(paths).load()
    expect(result).toEqual({ sessions: [], source: 'unavailable', canPersist: false })
  })

  it('writes PascalCase primary and backup snapshots atomically', async () => {
    const paths = await createPaths()
    const repository = new JsonSessionRepository(paths)
    const session: ConversationSession = {
      id: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
      title: '会话',
      preview: '预览',
      updatedAt: '2026-08-23T12:00:00+08:00',
      messages: [{
        role: 'ai',
        content: '完成',
        isTransient: false,
        thinkingText: '思考',
        tools: [{
          id: 'call-1',
          name: 'navisworks_find_items',
          status: 'success',
          arguments: { query: '支架' },
          result: { items: [] },
          error: '',
        }],
      }],
      contextTokensUsed: 512,
      pinnedAt: null,
    }

    await expect(repository.save([session])).resolves.toBe(true)
    const primary = await readFile(paths.sessionsFile, 'utf8')
    expect(primary).toBe(await readFile(paths.sessionsBackupFile, 'utf8'))
    expect(primary).toContain('"Messages"')
    expect(primary).toContain('"Role": "ai"')
    expect(primary).not.toContain('"role"')
    expect(primary).not.toContain('ToolEvents')
    expect(primary).toContain('"Name": "navisworks_find_items"')

    const loaded = await repository.load()
    expect(loaded.sessions[0]?.messages?.[0]?.tools).toEqual(session.messages?.[0]?.tools)
  })

  it('loads legacy settings and preserves historical CustomProfile field names', async () => {
    const paths = await createPaths()
    await writeFile(paths.settingsFile, JSON.stringify({
      SelectedModel: 'qwen-test',
      Models: ['qwen-test'],
      Plugins: [],
      Skills: [],
      ReasoningMode: 'fast',
      ActiveSessionId: null,
      Profile: 'quality',
      CustomProfileModel: 'retired',
    }), 'utf8')

    const repository = new JsonSettingsRepository(paths)
    const loaded = await repository.load()
    expect(loaded?.contextWindowTokens).toBe(8192)
    expect(loaded?.numPredict).toBe(2048)
    expect(loaded?.themeMode).toBe('system')

    const next: AppSettings = { ...loaded!, gpuVramGb: 12.5, themeMode: 'dark' }
    await expect(repository.save(next)).resolves.toBe(true)
    const saved = await readFile(paths.settingsFile, 'utf8')
    expect(saved).toContain('"CustomProfileContextWindowTokens": 8192')
    expect(saved).toContain('"ThemeMode": "dark"')
    expect(saved).not.toContain('"Profile"')
  })

  it('normalizes unsupported persisted theme values back to system', async () => {
    const paths = await createPaths()
    await writeFile(paths.settingsFile, JSON.stringify({
      SelectedModel: 'qwen-test',
      Models: ['qwen-test'],
      ThemeMode: 'auto'
    }), 'utf8')

    const loaded = await new JsonSettingsRepository(paths).load()
    expect(loaded?.themeMode).toBe('system')
    expect(loaded?.disabledTools).toEqual([])
  })

  it('round-trips disabled tools and drops names outside the catalog', async () => {
    const paths = await createPaths()
    const repository = new JsonSettingsRepository(paths)
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      disabledTools: ['navisworks_set_visibility', 'stale-tool'],
    }

    await expect(repository.save(settings)).resolves.toBe(true)
    const saved = await readFile(paths.settingsFile, 'utf8')
    expect(saved).toContain('"DisabledTools"')
    expect(saved).toContain('"navisworks_set_visibility"')

    const loaded = await repository.load()
    expect(loaded?.disabledTools).toEqual(['navisworks_set_visibility'])
  })

  it('round-trips the font scale and clamps hand-edited extremes', async () => {
    const paths = await createPaths()
    const repository = new JsonSettingsRepository(paths)
    await expect(repository.save({
      ...DEFAULT_APP_SETTINGS,
      fontScale: 1.15,
    })).resolves.toBe(true)
    expect(await repository.load()).toMatchObject({ fontScale: 1.15 })

    await writeFile(paths.settingsFile, JSON.stringify({
      SelectedModel: 'qwen-test',
      Models: ['qwen-test'],
      ThemeMode: 'dark',
      FontScale: 9,
    }), 'utf8')
    expect(await new JsonSettingsRepository(paths).load()).toMatchObject({ fontScale: 1.3 })
  })

  it('round-trips provider settings and defaults legacy files', async () => {
    const paths = await createPaths()
    const repository = new JsonSettingsRepository(paths)
    await expect(repository.save({
      ...DEFAULT_APP_SETTINGS,
      providerEnabled: false,
      providerBaseUrl: 'http://192.168.1.20:11434',
      providerApiKey: 'sk-test',
    })).resolves.toBe(true)

    const loaded = await repository.load()
    expect(loaded?.providerEnabled).toBe(false)
    expect(loaded?.providerBaseUrl).toBe('http://192.168.1.20:11434')
    expect(loaded?.providerApiKey).toBe('sk-test')

    // A legacy file without provider fields falls back to enabled + defaults.
    await writeFile(paths.settingsFile, JSON.stringify({
      SelectedModel: 'qwen-test',
      Models: ['qwen-test'],
      ThemeMode: 'dark',
    }), 'utf8')
    const legacy = await new JsonSettingsRepository(paths).load()
    expect(legacy?.providerEnabled).toBe(true)
    expect(legacy?.providerBaseUrl).toBe('')
    expect(legacy?.providerApiKey).toBe('')
  })
})

async function createPaths() {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), 'navisworks-electron-test-'))
  temporaryDirectories.push(rootDirectory)
  return {
    rootDirectory,
    sessionsFile: path.join(rootDirectory, 'sessions.json'),
    sessionsBackupFile: path.join(rootDirectory, 'sessions.backup.json'),
    settingsFile: path.join(rootDirectory, 'settings.json'),
    startupLogFile: path.join(rootDirectory, 'startup.log'),
    buildConfiguration: 'Debug' as const,
    sourceDescription: 'test',
  }
}
