import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDataPaths } from '../dataPaths'

describe('desktop data paths', () => {
  it('keeps Electron Debug data isolated from WPF Debug data', () => {
    const paths = createDataPaths({
      argv: [],
      env: {},
      isPackaged: false,
      localAppData: 'C:\\Users\\test\\AppData\\Local',
    })

    expect(paths.rootDirectory).toBe(path.resolve(
      'C:\\Users\\test\\AppData\\Local',
      'NavisworksMcpDesktop.Electron.Debug',
    ))
    expect(paths.rootDirectory).not.toContain('NavisworksMcpDesktop.Debug')
    expect(paths.buildConfiguration).toBe('Debug')
  })

  it('uses command line override before environment and expands variables', () => {
    const paths = createDataPaths({
      argv: ['--data-dir=%TEST_ROOT%\\command'],
      env: {
        TEST_ROOT: 'D:\\isolated',
        NAVISWORKS_MCP_DESKTOP_DATA_DIR: 'D:\\environment',
      },
      isPackaged: false,
    })

    expect(paths.rootDirectory).toBe(path.resolve('D:\\isolated\\command'))
    expect(paths.sourceDescription).toBe('命令行 --data-dir')
  })

  it('uses a separate packaged Electron profile', () => {
    const paths = createDataPaths({
      argv: [],
      env: {},
      isPackaged: true,
      localAppData: 'C:\\Users\\test\\AppData\\Local',
    })

    expect(paths.rootDirectory).toBe(path.resolve(
      'C:\\Users\\test\\AppData\\Local',
      'NavisworksMcpDesktop.Electron',
    ))
    expect(paths.buildConfiguration).toBe('Production')
  })
})
