import { createHash, randomBytes, randomUUID } from 'node:crypto'

export * from './icu.js'
export * from './structured-message.js'
export * from './localization-formats.js'
export * from './localization-exchange.types.js'
export * from './po-format.js'
export * from './xliff-format.js'
export * from './platform-formats.js'

export const MAX_RELEASE_HISTORY = 50

export type LocaleCode = string
export type FlatTranslations = Record<string, Record<LocaleCode, string>>

export type TranslationOverlay = {
  id: string
  slug: string
  parentId: string | null
  values: FlatTranslations
}

/** Materializes each overlay on top of base + all ancestors for immutable delivery artifacts. */
export function materializeOverlays(
  base: FlatTranslations,
  overlays: TranslationOverlay[],
): Array<{ id: string; slug: string; snapshot: FlatTranslations }> {
  const byId = new Map(overlays.map((overlay) => [overlay.id, overlay]))
  const resolved = new Map<string, FlatTranslations>()
  const resolving = new Set<string>()
  const resolve = (overlay: TranslationOverlay): FlatTranslations => {
    const cached = resolved.get(overlay.id)
    if (cached) return cached
    if (resolving.has(overlay.id)) throw new Error('Overlay hierarchy contains a cycle')
    resolving.add(overlay.id)
    const parent = overlay.parentId ? byId.get(overlay.parentId) : undefined
    if (overlay.parentId && !parent) throw new Error('Overlay parent is missing')
    const snapshot = mergeTranslationSnapshots(parent ? resolve(parent) : base, overlay.values)
    resolving.delete(overlay.id)
    resolved.set(overlay.id, snapshot)
    return snapshot
  }
  return overlays.map((overlay) => ({
    id: overlay.id,
    slug: overlay.slug,
    snapshot: resolve(overlay),
  }))
}

export function mergeTranslationSnapshots(
  base: FlatTranslations,
  overrides: FlatTranslations,
): FlatTranslations {
  const result = clone(base)
  for (const [key, values] of Object.entries(overrides)) {
    result[key] = { ...(result[key] ?? {}), ...values }
  }
  return result
}

export const TRANSLATION_STATUSES = [
  'untranslated',
  'machine_translated',
  'translated',
  'in_review',
  'approved',
  'rejected',
  'source_changed',
] as const

export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number]

export const EDITABLE_TRANSLATION_STATUSES = [
  'translated',
  'in_review',
  'approved',
  'rejected',
] as const satisfies readonly TranslationStatus[]

export type EditableTranslationStatus = (typeof EDITABLE_TRANSLATION_STATUSES)[number]

export interface Release {
  id: string
  sequence: number
  message: string
  author: string
  createdAt: string
  snapshot: FlatTranslations
}

export interface Branch {
  id: string
  projectId: string
  name: string
  publicKey: string
  draft: FlatTranslations
  releases: Release[]
  publishedReleaseId?: string
  draftUpdatedAt?: string
}

export interface Change {
  key: string
  locale: string
  before?: string
  after?: string
  kind: 'added' | 'updated' | 'deleted'
}

export type MergeConflict = {
  key: string
  locale: string
  base: string | null
  source: string | null
  target: string | null
}

export type MergeResolution = {
  key: string
  locale: string
  value: string | null
}

export type ThreeWayMerge = {
  snapshot: FlatTranslations
  automaticChanges: Change[]
  conflicts: MergeConflict[]
}

export type LocaleResolutionReason = 'selected' | 'mapped' | 'device' | 'fallback'

export function resolveLocale(input: {
  translatedLocales: string[]
  fallbackLocale: string
  localeMappings?: Record<string, string>
  selectedLocale?: string
  deviceLocales?: string[]
}): { locale: string; requestedLocale: string; reason: LocaleResolutionReason } {
  const translated = new Map(
    input.translatedLocales.map((locale) => [normalizeLocale(locale), locale]),
  )
  const mappings = new Map(
    Object.entries(input.localeMappings ?? {}).map(([from, to]) => [
      normalizeLocale(from),
      { source: from, target: to },
    ]),
  )
  const resolveCandidate = (candidate: string | undefined) => {
    if (!candidate) return undefined
    const normalized = normalizeLocale(candidate)
    const mapped = mappings.get(normalized) ?? mappings.get(normalized.split('-')[0]!)
    if (mapped && translated.has(normalizeLocale(mapped.target))) {
      return {
        locale: translated.get(normalizeLocale(mapped.target))!,
        requestedLocale: mapped.source,
        mapped: true,
      }
    }
    const direct = translated.get(normalized)
    if (direct) return { locale: direct, requestedLocale: direct, mapped: false }
    const language = normalized.split('-')[0]!
    const languageMatch = [...translated.entries()].find(
      ([locale]) => locale.split('-')[0] === language,
    )
    return languageMatch
      ? { locale: languageMatch[1], requestedLocale: languageMatch[1], mapped: false }
      : undefined
  }

  if (input.selectedLocale) {
    const selected = resolveCandidate(input.selectedLocale)
    return selected
      ? {
          locale: selected.locale,
          requestedLocale: selected.requestedLocale,
          reason: selected.mapped ? 'mapped' : 'selected',
        }
      : {
          locale: input.fallbackLocale,
          requestedLocale: input.fallbackLocale,
          reason: 'fallback',
        }
  }
  for (const deviceLocale of input.deviceLocales ?? []) {
    const device = resolveCandidate(deviceLocale)
    if (device)
      return {
        locale: device.locale,
        requestedLocale: device.requestedLocale,
        reason: device.mapped ? 'mapped' : 'device',
      }
  }
  return {
    locale: input.fallbackLocale,
    requestedLocale: input.fallbackLocale,
    reason: 'fallback',
  }
}

export type MissingTranslationStrategy =
  'reject' | 'use_fallback' | 'omit_incomplete' | 'remove_incomplete'

export type IncompleteTranslation = { key: string; locales: string[] }

export function prepareReleaseSnapshot(
  draft: FlatTranslations,
  input: {
    translatedLocales: string[]
    fallbackLocale: string
    strategy: MissingTranslationStrategy
  },
): { snapshot: FlatTranslations; incomplete: IncompleteTranslation[] } {
  const snapshot = clone(draft)
  const incomplete = Object.entries(snapshot)
    .map(([key, values]) => ({
      key,
      locales: input.translatedLocales.filter((locale) => values[locale] === undefined),
    }))
    .filter(({ locales }) => locales.length > 0)

  if (input.strategy === 'use_fallback') {
    for (const item of incomplete) {
      const fallback = snapshot[item.key]?.[input.fallbackLocale]
      if (fallback === undefined) {
        throw new Error(`Fallback translation is missing for ${item.key}`)
      }
      for (const locale of item.locales) snapshot[item.key]![locale] = fallback
    }
  } else if (input.strategy === 'omit_incomplete' || input.strategy === 'remove_incomplete') {
    for (const item of incomplete) delete snapshot[item.key]
  }

  return { snapshot, incomplete }
}

function normalizeLocale(locale: string): string {
  return locale.trim().replaceAll('_', '-').toLowerCase()
}

const clone = <T>(value: T): T => structuredClone(value)

export function setDraftValue(
  branch: Branch,
  key: string,
  locale: LocaleCode,
  value: string | undefined,
): Branch {
  assertKey(key)
  const next = clone(branch)
  const values = { ...(next.draft[key] ?? {}) }
  if (value === undefined || value === '') delete values[locale]
  else values[locale] = value
  if (Object.keys(values).length === 0) delete next.draft[key]
  else next.draft[key] = values
  next.draftUpdatedAt = new Date().toISOString()
  return next
}

export function publish(
  branch: Branch,
  input: { message: string; author: string; maxHistory?: number },
): Branch {
  const message = input.message.trim()
  if (!message) throw new Error('A publish message is required')
  const release: Release = {
    id: `rel_${randomUUID()}`,
    sequence: (branch.releases.at(-1)?.sequence ?? 0) + 1,
    message,
    author: input.author,
    createdAt: new Date().toISOString(),
    snapshot: clone(branch.draft),
  }
  const max = Math.max(1, input.maxHistory ?? MAX_RELEASE_HISTORY)
  const releases = [...branch.releases, release].slice(-max)
  return { ...branch, releases, publishedReleaseId: release.id }
}

export function cloneBranch(source: Branch, name: string, projectId = source.projectId): Branch {
  return {
    id: `branch_${randomUUID()}`,
    projectId,
    name,
    publicKey: createPublicBranchKey(),
    draft: clone(source.draft),
    releases: [],
  }
}

export function overwriteDraft(target: Branch, source: Branch): Branch {
  return { ...target, draft: clone(source.draft), draftUpdatedAt: new Date().toISOString() }
}

export function restoreReleaseToDraft(branch: Branch, releaseId: string): Branch {
  const release = branch.releases.find((item) => item.id === releaseId)
  if (!release) throw new Error('Release not found')
  return { ...branch, draft: clone(release.snapshot), draftUpdatedAt: new Date().toISOString() }
}

export function getPublishedSnapshot(branch: Branch): FlatTranslations {
  const release = branch.releases.find((item) => item.id === branch.publishedReleaseId)
  if (!release) return {}
  return clone(release.snapshot)
}

export function diffSnapshots(before: FlatTranslations, after: FlatTranslations): Change[] {
  const changes: Change[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of [...keys].sort()) {
    const locales = new Set([...Object.keys(before[key] ?? {}), ...Object.keys(after[key] ?? {})])
    for (const locale of [...locales].sort()) {
      const previous = before[key]?.[locale]
      const current = after[key]?.[locale]
      if (previous === current) continue
      changes.push({
        key,
        locale,
        before: previous,
        after: current,
        kind: previous === undefined ? 'added' : current === undefined ? 'deleted' : 'updated',
      })
    }
  }
  return changes
}

/** Computes a cell-level merge without mutating any input snapshot. */
export function threeWayMerge(
  base: FlatTranslations,
  source: FlatTranslations,
  target: FlatTranslations,
  resolutions: MergeResolution[] = [],
): ThreeWayMerge {
  const snapshot = clone(target)
  const automaticChanges: Change[] = []
  const conflicts: MergeConflict[] = []
  const resolved = new Map(resolutions.map((item) => [cellId(item.key, item.locale), item.value]))
  const keys = new Set([...Object.keys(base), ...Object.keys(source), ...Object.keys(target)])

  for (const key of [...keys].sort()) {
    const locales = new Set([
      ...Object.keys(base[key] ?? {}),
      ...Object.keys(source[key] ?? {}),
      ...Object.keys(target[key] ?? {}),
    ])
    for (const locale of [...locales].sort()) {
      const before = base[key]?.[locale]
      const incoming = source[key]?.[locale]
      const current = target[key]?.[locale]
      if (incoming === current || incoming === before) continue
      if (current === before) {
        setSnapshotCell(snapshot, key, locale, incoming)
        automaticChanges.push(changeFor(key, locale, current, incoming))
        continue
      }
      const resolutionId = cellId(key, locale)
      if (resolved.has(resolutionId)) {
        setSnapshotCell(snapshot, key, locale, resolved.get(resolutionId) ?? undefined)
        continue
      }
      conflicts.push({
        key,
        locale,
        base: before ?? null,
        source: incoming ?? null,
        target: current ?? null,
      })
    }
  }
  return { snapshot, automaticChanges, conflicts }
}

export function mergeFingerprint(
  base: FlatTranslations,
  source: FlatTranslations,
  target: FlatTranslations,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        canonicalSnapshot(base),
        canonicalSnapshot(source),
        canonicalSnapshot(target),
      ]),
    )
    .digest('hex')
}

export function snapshotFingerprint(snapshot: FlatTranslations): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalSnapshot(snapshot)))
    .digest('hex')
}

function setSnapshotCell(
  snapshot: FlatTranslations,
  key: string,
  locale: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete snapshot[key]?.[locale]
    if (snapshot[key] && Object.keys(snapshot[key]).length === 0) delete snapshot[key]
    return
  }
  ;(snapshot[key] ??= {})[locale] = value
}

function changeFor(
  key: string,
  locale: string,
  before: string | undefined,
  after: string | undefined,
): Change {
  return {
    key,
    locale,
    before,
    after,
    kind: before === undefined ? 'added' : after === undefined ? 'deleted' : 'updated',
  }
}

function cellId(key: string, locale: string): string {
  return `${key}\u0000${locale}`
}

function canonicalSnapshot(snapshot: FlatTranslations): FlatTranslations {
  return Object.fromEntries(
    Object.keys(snapshot)
      .sort()
      .map((key) => [
        key,
        Object.fromEntries(
          Object.entries(snapshot[key] ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
  )
}

export function localeBundle(snapshot: FlatTranslations, locale: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const [key, translations] of Object.entries(snapshot)) {
    const value = translations[locale]
    if (value === undefined) continue
    const segments = key.split('.')
    let cursor = root
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) cursor[segment] = value
      else {
        const existing = cursor[segment]
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
          cursor[segment] = {}
        }
        cursor = cursor[segment] as Record<string, unknown>
      }
    })
  }
  return root
}

export function bundleEtag(branch: Branch, locale: string): string {
  return `\"${createHash('sha256')
    .update(`${branch.id}:${branch.publishedReleaseId ?? 'empty'}:${locale}`)
    .digest('base64url')}\"`
}

export function createPublicBranchKey(): string {
  return `br_live_${randomBytes(18).toString('base64url')}`
}

function assertKey(key: string): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(key)) {
    throw new Error('Keys must be lower_snake_case dotted paths')
  }
}
