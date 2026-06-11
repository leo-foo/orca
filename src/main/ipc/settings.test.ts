import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  applyAppIconMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  browserWindowFromWebContentsMock,
  dialogShowOpenDialogMock,
  dialogShowSaveDialogMock,
  handleMock,
  previewGhosttyImportMock,
  readFileMock,
  rebuildAppMenuMock,
  writeFileMock
} = vi.hoisted(() => ({
  applyAppIconMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  dialogShowSaveDialogMock: vi.fn(),
  handleMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  readFileMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  writeFileMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock,
    getAllWindows: browserWindowGetAllWindowsMock
  },
  dialog: {
    showOpenDialog: dialogShowOpenDialogMock,
    showSaveDialog: dialogShowSaveDialogMock
  },
  ipcMain: { handle: handleMock },
  nativeTheme: { themeSource: 'system' }
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock
}))

vi.mock('../ghostty/index', () => ({
  previewGhosttyImport: previewGhosttyImportMock
}))

vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: applyElectronProxySettingsMock
}))

vi.mock('../app-icon', () => ({
  applyAppIcon: applyAppIconMock
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

import { registerSettingsHandlers } from './settings'
import { getDefaultSettings } from '../../shared/constants'
import { createSettingsExportDocument } from '../../shared/settings-portability'

const settingsInvokeEvent = { sender: { id: 1 } }
type SettingsChangedListener = (
  updates: unknown,
  settings: unknown,
  originWebContentsId?: number
) => void

const store = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    applyAppIconMock.mockClear()
    applyElectronProxySettingsMock.mockClear()
    applyElectronProxySettingsMock.mockResolvedValue({ source: 'settings' })
    previewGhosttyImportMock.mockClear()
    rebuildAppMenuMock.mockClear()
    browserWindowGetAllWindowsMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    dialogShowOpenDialogMock.mockReset()
    dialogShowSaveDialogMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.onSettingsChanged.mockClear()
  })

  it('registers settings:previewGhosttyImport handler', () => {
    registerSettingsHandlers(store as never)
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('settings:previewGhosttyImport')
  })

  it('exports portable settings and keybindings to a JSON file', async () => {
    const keybindings = {
      getSnapshot: vi.fn(() => ({
        commonOverrides: { 'app.settings': ['Ctrl+,'] },
        platformOverrides: { darwin: { 'app.settings': ['Cmd+,'] } }
      }))
    }
    const settings = {
      ...getDefaultSettings('/Users/test'),
      theme: 'dark' as const,
      workspaceDir: '/Users/test/private-workspaces'
    }
    store.getSettings.mockReturnValue(settings)
    dialogShowSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/orca.json' })
    registerSettingsHandlers(store as never, undefined, keybindings as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:exportPortable'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    const result = await handler(settingsInvokeEvent)

    expect(result).toMatchObject({ success: true, filePath: '/tmp/orca.json' })
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const exported = JSON.parse(writeFileMock.mock.calls[0][1])
    expect(exported.settings.theme).toBe('dark')
    expect(exported.settings.workspaceDir).toBeUndefined()
    expect(exported.keybindings).toEqual({
      keybindings: { 'app.settings': ['Ctrl+,'] },
      platforms: { darwin: { 'app.settings': ['Cmd+,'] } }
    })
  })

  it('previews a portable import with changed and skipped keys plus the picked path', async () => {
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/orca.json'] })
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...createSettingsExportDocument(getDefaultSettings('/Users/test')),
        settings: {
          theme: 'dark',
          workspaceDir: '/Users/test/should-not-import'
        },
        keybindings: { keybindings: {}, platforms: {} }
      })
    )
    store.getSettings.mockReturnValue({ theme: 'system' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewPortableImport'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    expect(await handler(settingsInvokeEvent)).toMatchObject({
      ok: true,
      filePath: '/tmp/orca.json',
      portableSettingCount: 1,
      changedSettingKeys: ['theme'],
      skippedSettingKeys: ['workspaceDir'],
      includesKeybindings: true
    })
  })

  it('reports a cancelled preview when the open dialog is dismissed', async () => {
    dialogShowOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewPortableImport'
    )?.[1] as (_event: typeof settingsInvokeEvent) => Promise<unknown>

    expect(await handler(settingsInvokeEvent)).toMatchObject({ ok: false, cancelled: true })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('imports only portable settings and keybindings from a JSON file', async () => {
    const keybindings = { replacePortableOverrides: vi.fn(() => ({ overrides: {} })) }
    const send = vi.fn()
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } }
    ])
    readFileMock.mockResolvedValue(
      JSON.stringify({
        ...createSettingsExportDocument(getDefaultSettings('/Users/test'), {
          keybindings: { keybindings: { 'app.settings': ['Ctrl+,'] }, platforms: {} }
        }),
        settings: {
          theme: 'dark',
          workspaceDir: '/Users/test/should-not-import'
        }
      })
    )
    store.getSettings.mockReturnValue({ theme: 'system' })
    store.updateSettings.mockReturnValue({ theme: 'dark' })
    registerSettingsHandlers(store as never, undefined, keybindings as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:importPortable'
    )?.[1] as (_event: typeof settingsInvokeEvent, filePath: string) => Promise<unknown>

    const result = await handler(settingsInvokeEvent, '/tmp/orca.json')

    expect(result).toMatchObject({
      success: true,
      portableSettingCount: 1,
      skippedSettingKeys: ['workspaceDir'],
      includesKeybindings: true
    })
    expect(store.updateSettings).toHaveBeenCalledWith(
      { theme: 'dark' },
      { notifyListeners: true, originWebContentsId: undefined }
    )
    expect(keybindings.replacePortableOverrides).toHaveBeenCalledWith({
      keybindings: { 'app.settings': ['Ctrl+,'] },
      platforms: {}
    })
    expect(send).toHaveBeenCalledWith('keybindings:changed', { overrides: {} })
  })

  it('settings:previewGhosttyImport returns preview result', async () => {
    const expected = { found: false, diff: {}, unsupportedKeys: [] }
    previewGhosttyImportMock.mockResolvedValue(expected)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'settings:previewGhosttyImport'
    )?.[1] as (_event: unknown, args: unknown) => Promise<unknown>

    const result = await handler!(null, {})
    expect(result).toEqual(expected)
    expect(previewGhosttyImportMock).toHaveBeenCalledWith(store)
  })

  it('broadcasts store-level settings changes to open windows', () => {
    const send = vi.fn()
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: vi.fn() } }
    ])
    registerSettingsHandlers(store as never)

    const onSettingsChanged = store.onSettingsChanged as unknown as {
      mock: { calls: [SettingsChangedListener][] }
    }
    const listener = onSettingsChanged.mock.calls[0]?.[0]
    if (!listener) {
      throw new Error('settings change listener was not registered')
    }
    listener({ defaultTuiAgent: 'codex' }, { defaultTuiAgent: 'codex' })

    expect(send).toHaveBeenCalledWith('settings:changed', { defaultTuiAgent: 'codex' })
  })

  it('does not rebroadcast renderer settings writes to the origin window', () => {
    const originSend = vi.fn()
    const otherSend = vi.fn()
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { id: 1, send: originSend } },
      { isDestroyed: () => false, webContents: { id: 2, send: otherSend } }
    ])
    registerSettingsHandlers(store as never)

    const onSettingsChanged = store.onSettingsChanged as unknown as {
      mock: { calls: [SettingsChangedListener][] }
    }
    const listener = onSettingsChanged.mock.calls[0]?.[0]
    if (!listener) {
      throw new Error('settings change listener was not registered')
    }
    listener({ defaultTuiAgent: 'codex' }, { defaultTuiAgent: 'codex' }, 1)

    expect(originSend).not.toHaveBeenCalled()
    expect(otherSend).toHaveBeenCalledWith('settings:changed', { defaultTuiAgent: 'codex' })
  })

  it('updates the agent awake service when the keep-awake setting changes', () => {
    const agentAwakeService = { setEnabled: vi.fn() }
    store.getSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    store.updateSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: true })
    registerSettingsHandlers(store as never, agentAwakeService as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => unknown

    handler(settingsInvokeEvent, { keepComputerAwakeWhileAgentsRun: true })

    expect(agentAwakeService.setEnabled).toHaveBeenCalledWith(true)
  })

  it('does not notify the agent awake service for unrelated setting changes', () => {
    const agentAwakeService = { setEnabled: vi.fn() }
    store.getSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    store.updateSettings.mockReturnValue({ keepComputerAwakeWhileAgentsRun: false })
    registerSettingsHandlers(store as never, agentAwakeService as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => unknown

    handler(settingsInvokeEvent, { defaultTuiAgent: 'codex' })

    expect(agentAwakeService.setEnabled).not.toHaveBeenCalled()
  })

  it('does not accept floating workspace trust grants from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ floatingTerminalTrustedCwds: [] })
    store.updateSettings.mockReturnValue({ floatingTerminalTrustedCwds: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { floatingTerminalTrustedCwds: ['/tmp/notes'] })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {},
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('sanitizes and applies proxy settings from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: '' })
    store.updateSettings.mockReturnValue({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost;*.internal'
    })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      httpProxyUrl: ' http://proxy.example:8080/path#frag ',
      httpProxyBypassRules: 'localhost, *.internal'
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        httpProxyUrl: 'http://proxy.example:8080',
        httpProxyBypassRules: 'localhost;*.internal'
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyElectronProxySettingsMock).toHaveBeenCalledWith({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost;*.internal'
    })
  })

  it('drops invalid proxy URLs at the settings boundary', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: 'http://proxy.example:8080' })
    store.updateSettings.mockReturnValue({ httpProxyUrl: '' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { httpProxyUrl: 'ftp://proxy.example:2121' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { httpProxyUrl: '' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyElectronProxySettingsMock).toHaveBeenCalledWith({ httpProxyUrl: '' })
  })

  it('normalizes and applies app icon changes from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ appIcon: 'classic' })
    store.updateSettings.mockReturnValue({ appIcon: 'watercolor' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { appIcon: 'watercolor' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { appIcon: 'watercolor' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyAppIconMock).toHaveBeenCalledWith('watercolor')
  })

  it('falls back to the classic app icon for invalid renderer settings IPC values', async () => {
    store.getSettings.mockReturnValue({ appIcon: 'watercolor' })
    store.updateSettings.mockReturnValue({ appIcon: 'classic' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { appIcon: 'not-real' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { appIcon: 'classic' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyAppIconMock).toHaveBeenCalledWith('classic')
  })

  it('rebuilds the app menu after Automations sidebar visibility changes', async () => {
    store.getSettings.mockReturnValue({ showAutomationsButton: true })
    store.updateSettings.mockReturnValue({ showAutomationsButton: false })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { showAutomationsButton: false })

    expect(rebuildAppMenuMock).toHaveBeenCalledTimes(1)
  })
})
