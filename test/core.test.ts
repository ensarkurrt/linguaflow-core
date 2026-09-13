import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EDITABLE_TRANSLATION_STATUSES,
  TRANSLATION_STATUSES,
  bundleEtag,
  cloneBranch,
  diffSnapshots,
  localeBundle,
  mergeFingerprint,
  prepareReleaseSnapshot,
  publish,
  resolveLocale,
  restoreReleaseToDraft,
  setDraftValue,
  threeWayMerge,
  type Branch,
} from '../src/index.ts'

const seed = (): Branch => ({
  id: 'branch_1',
  projectId: 'project_1',
  name: 'production',
  publicKey: 'br_live_demo',
  draft: { 'home.hero.title': { en: 'Ship globally', tr: 'Dünyaya açıl' } },
  releases: [],
})

test('translation workflow exposes stable and editable status sets', () => {
  assert.deepEqual(TRANSLATION_STATUSES, [
    'untranslated',
    'machine_translated',
    'translated',
    'in_review',
    'approved',
    'rejected',
    'source_changed',
  ])
  assert.deepEqual(EDITABLE_TRANSLATION_STATUSES, [
    'translated',
    'in_review',
    'approved',
    'rejected',
  ])
})

test('draft stays private until publish and bundle is nested', () => {
  let branch = publish(seed(), { message: 'Initial', author: 'Ada' })
  const oldEtag = bundleEtag(branch, 'en')
  branch = setDraftValue(branch, 'home.hero.title', 'en', 'New draft')
  assert.deepEqual(localeBundle(branch.releases[0]!.snapshot, 'en'), {
    home: { hero: { title: 'Ship globally' } },
  })
  branch = publish(branch, { message: 'Update hero', author: 'Ada' })
  assert.notEqual(bundleEtag(branch, 'en'), oldEtag)
})

test('clone gets independent delivery identity and revert creates a draft', () => {
  let branch = publish(seed(), { message: 'Initial', author: 'Ada' })
  const firstId = branch.publishedReleaseId!
  branch = setDraftValue(branch, 'home.hero.title', 'en', 'Changed')
  branch = publish(branch, { message: 'Second', author: 'Ada' })
  const restored = restoreReleaseToDraft(branch, firstId)
  assert.equal(restored.draft['home.hero.title']?.en, 'Ship globally')
  const testBranch = cloneBranch(restored, 'test')
  assert.notEqual(testBranch.publicKey, branch.publicKey)
})

test('diff reports locale-level changes', () => {
  assert.deepEqual(diffSnapshots({ title: { en: 'Old' } }, { title: { en: 'New', tr: 'Yeni' } }), [
    { key: 'title', locale: 'en', before: 'Old', after: 'New', kind: 'updated' },
    { key: 'title', locale: 'tr', before: undefined, after: 'Yeni', kind: 'added' },
  ])
})

test('three-way merge applies safe changes and reports divergent cells', () => {
  const base = { title: { en: 'Base', tr: 'Temel' }, removed: { en: 'Old' } }
  const source = { title: { en: 'Source', tr: 'Temel' }, added: { en: 'New' } }
  const target = { title: { en: 'Target', tr: 'Hedef' }, removed: { en: 'Old' } }
  const preview = threeWayMerge(base, source, target)
  assert.deepEqual(preview.automaticChanges, [
    { key: 'added', locale: 'en', before: undefined, after: 'New', kind: 'added' },
    { key: 'removed', locale: 'en', before: 'Old', after: undefined, kind: 'deleted' },
  ])
  assert.deepEqual(preview.conflicts, [
    { key: 'title', locale: 'en', base: 'Base', source: 'Source', target: 'Target' },
  ])
  assert.equal(preview.snapshot.title?.tr, 'Hedef')
  const resolved = threeWayMerge(base, source, target, [
    { key: 'title', locale: 'en', value: 'Combined' },
  ])
  assert.equal(resolved.snapshot.title?.en, 'Combined')
  assert.equal(resolved.conflicts.length, 0)
  assert.equal(mergeFingerprint(base, source, target), mergeFingerprint(base, source, target))
})

test('locale resolution preserves explicit user intent and supports mappings', () => {
  assert.deepEqual(
    resolveLocale({
      translatedLocales: ['en', 'he'],
      fallbackLocale: 'en',
      localeMappings: { ar: 'he' },
      deviceLocales: ['ar-SA'],
    }),
    { locale: 'he', requestedLocale: 'ar', reason: 'mapped' },
  )
  assert.deepEqual(
    resolveLocale({
      translatedLocales: ['en', 'tr'],
      fallbackLocale: 'en',
      selectedLocale: 'de',
      deviceLocales: ['tr'],
    }),
    { locale: 'en', requestedLocale: 'en', reason: 'fallback' },
  )
  assert.deepEqual(
    resolveLocale({
      translatedLocales: ['en-US', 'tr'],
      fallbackLocale: 'tr',
      deviceLocales: ['en-GB'],
    }),
    { locale: 'en-US', requestedLocale: 'en-US', reason: 'device' },
  )
})

test('release preparation can fill fallback values or omit incomplete keys', () => {
  const draft = {
    complete: { en: 'Ready', tr: 'Hazır' },
    incomplete: { en: 'Fallback' },
  }
  const filled = prepareReleaseSnapshot(draft, {
    translatedLocales: ['en', 'tr'],
    fallbackLocale: 'en',
    strategy: 'use_fallback',
  })
  assert.equal(filled.snapshot.incomplete?.tr, 'Fallback')
  assert.deepEqual(filled.incomplete, [{ key: 'incomplete', locales: ['tr'] }])
  const omitted = prepareReleaseSnapshot(draft, {
    translatedLocales: ['en', 'tr'],
    fallbackLocale: 'en',
    strategy: 'omit_incomplete',
  })
  assert.deepEqual(Object.keys(omitted.snapshot), ['complete'])
  assert.equal(draft.incomplete?.tr, undefined)
})
