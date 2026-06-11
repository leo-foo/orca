import type { GlobalSettings } from './types'
import { PORTABLE_SETTINGS_KEYS } from './settings-portability-keys'
import {
  isSupportedPortableSettingValue,
  sanitizePortableSettingValue
} from './settings-portability-values'

export const SETTINGS_EXPORT_FORMAT_VERSION = 1
export const SETTINGS_EXPORT_KIND = 'orca-settings-export'

export type SettingsExportDocument = {
  kind: typeof SETTINGS_EXPORT_KIND
  version: typeof SETTINGS_EXPORT_FORMAT_VERSION
  exportedAt: string
  settings: Partial<GlobalSettings>
  keybindings?: unknown
}

export type SettingsImportPreview = {
  ok: boolean
  cancelled?: boolean
  filePath?: string
  portableSettingCount: number
  changedSettingKeys: string[]
  skippedSettingKeys: string[]
  includesKeybindings: boolean
  error?: string
}

export type SettingsExportResult =
  | { success: true; filePath: string; portableSettingCount: number; includesKeybindings: boolean }
  | { success: false; cancelled?: boolean; error?: string }

export type SettingsImportResult =
  | {
      success: true
      portableSettingCount: number
      skippedSettingKeys: string[]
      includesKeybindings: boolean
    }
  | { success: false; error?: string }

const PORTABLE_SETTINGS_KEY_SET = new Set<string>(PORTABLE_SETTINGS_KEYS)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Why: hand-edited or differently-ordered export files must not read as
// "changed" when the values match, so comparisons sort object keys first.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createSettingsExportDocument(
  settings: GlobalSettings,
  options: { keybindings?: unknown; exportedAt?: string } = {}
): SettingsExportDocument {
  const exportedSettings: Partial<GlobalSettings> = {}
  for (const key of PORTABLE_SETTINGS_KEYS) {
    if (!(key in settings)) {
      continue
    }
    const value = settings[key]
    if (value === undefined) {
      continue
    }
    ;(exportedSettings as Record<string, unknown>)[key] = sanitizePortableSettingValue(key, value)
  }

  return {
    kind: SETTINGS_EXPORT_KIND,
    version: SETTINGS_EXPORT_FORMAT_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    settings: exportedSettings,
    ...(options.keybindings !== undefined
      ? { keybindings: cloneJsonValue(options.keybindings) }
      : {})
  }
}

export function readSettingsExportDocument(input: unknown): {
  document?: SettingsExportDocument
  error?: string
} {
  if (!isPlainObject(input)) {
    return { error: 'Settings export must contain a JSON object.' }
  }
  if (input.kind !== SETTINGS_EXPORT_KIND || input.version !== SETTINGS_EXPORT_FORMAT_VERSION) {
    return { error: 'This file is not a supported Orca settings export.' }
  }
  if (!isPlainObject(input.settings)) {
    return { error: 'Settings export is missing a settings object.' }
  }
  if (typeof input.exportedAt !== 'string') {
    return { error: 'Settings export is missing an exportedAt timestamp.' }
  }
  return { document: input as SettingsExportDocument }
}

export function getPortableSettingsFromExport(document: SettingsExportDocument): {
  settings: Partial<GlobalSettings>
  skippedSettingKeys: string[]
} {
  const settings: Partial<GlobalSettings> = {}
  const skippedSettingKeys: string[] = []
  for (const [key, value] of Object.entries(document.settings)) {
    if (!PORTABLE_SETTINGS_KEY_SET.has(key)) {
      skippedSettingKeys.push(key)
      continue
    }
    const settingKey = key as keyof GlobalSettings
    if (value === undefined) {
      continue
    }
    if (!isSupportedPortableSettingValue(settingKey, value)) {
      skippedSettingKeys.push(key)
      continue
    }
    ;(settings as Record<string, unknown>)[key] = sanitizePortableSettingValue(settingKey, value)
  }
  return { settings, skippedSettingKeys }
}

export function previewSettingsExportImport(
  input: unknown,
  currentSettings: Partial<GlobalSettings>
): SettingsImportPreview {
  const parsed = readSettingsExportDocument(input)
  if (!parsed.document) {
    return {
      ok: false,
      portableSettingCount: 0,
      changedSettingKeys: [],
      skippedSettingKeys: [],
      includesKeybindings: false,
      error: parsed.error
    }
  }
  const portable = getPortableSettingsFromExport(parsed.document)
  const changedSettingKeys = Object.entries(portable.settings)
    .filter(([key, value]) => {
      const current = currentSettings[key as keyof GlobalSettings]
      return stableStringify(value) !== stableStringify(current)
    })
    .map(([key]) => key)
  return {
    ok: true,
    portableSettingCount: Object.keys(portable.settings).length,
    changedSettingKeys,
    skippedSettingKeys: portable.skippedSettingKeys,
    includesKeybindings: parsed.document.keybindings !== undefined
  }
}
