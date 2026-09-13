import {
  isArgumentElement,
  isDateElement,
  isLiteralElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser'
import { printAST } from '@formatjs/icu-messageformat-parser/printer.js'

export type IcuArgumentKind = 'string' | 'number' | 'date' | 'time' | 'select'

export type IcuContract = {
  arguments: Record<string, IcuArgumentKind>
  tags: string[]
}

export function icuContractsEqual(left: IcuContract, right: IcuContract): boolean {
  const leftArguments = Object.entries(left.arguments).sort(([a], [b]) => a.localeCompare(b))
  const rightArguments = Object.entries(right.arguments).sort(([a], [b]) => a.localeCompare(b))
  return (
    leftArguments.length === rightArguments.length &&
    leftArguments.every(
      ([name, kind], index) =>
        rightArguments[index]?.[0] === name && rightArguments[index]?.[1] === kind,
    ) &&
    [...left.tags].sort().join('\u0000') === [...right.tags].sort().join('\u0000')
  )
}

export type QaSeverity = 'blocker' | 'warning'

export type QaIssue = {
  key: string
  locale: string
  code:
    | 'icu_syntax'
    | 'argument_missing'
    | 'argument_extra'
    | 'argument_type'
    | 'tag_mismatch'
    | 'character_limit'
    | 'empty_translation'
    | 'fallback_translation_missing'
    | 'machine_translation_review'
    | 'translation_in_review'
    | 'translation_rejected'
    | 'source_translation_changed'
    | 'leading_whitespace'
    | 'trailing_whitespace'
  severity: QaSeverity
  message: string
}

export type QaEntry = {
  key: string
  values: Record<string, string>
  characterLimit?: number | null
}

/**
 * Parses the portable ICU subset supported by every LinguaFlow SDK:
 * arguments, plural/select, exact plural values, offset, pound and nesting.
 */
export function analyzeIcuMessage(message: string): IcuContract {
  const ast = parse(message)
  const argumentsByName = new Map<string, IcuArgumentKind>()
  const tags = new Set<string>()

  walk(ast, (element) => {
    let kind: IcuArgumentKind | undefined
    if (isArgumentElement(element)) kind = 'string'
    else if (isPluralElement(element)) {
      if (element.pluralType !== 'cardinal')
        throw new SyntaxError('selectordinal is not supported by the Flutter runtime yet')
      kind = 'number'
    } else if (isNumberElement(element) || isDateElement(element) || isTimeElement(element)) {
      throw new SyntaxError(
        'ICU number/date/time styles are not supported by the Flutter runtime yet',
      )
    } else if (isSelectElement(element)) kind = 'select'
    else if (isTagElement(element)) tags.add(element.value)
    if (!kind || !('value' in element)) return
    const current = argumentsByName.get(element.value)
    if (current && current !== kind) {
      throw new SyntaxError(
        `ICU argument "${element.value}" is used as both ${current} and ${kind}`,
      )
    }
    argumentsByName.set(element.value, kind)
  })

  return {
    arguments: Object.fromEntries(
      [...argumentsByName.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    tags: [...tags].sort(),
  }
}

export function validateTranslations(input: {
  sourceLocale: string
  fallbackLocale?: string
  locales: string[]
  entries: QaEntry[]
}): QaIssue[] {
  const issues: QaIssue[] = []
  for (const entry of input.entries) {
    const source = entry.values[input.sourceLocale]
    if (!source) {
      issues.push(
        issue(
          entry.key,
          input.sourceLocale,
          'empty_translation',
          'blocker',
          'Source translation is missing',
        ),
      )
      continue
    }
    const sourceContract = tryContract(entry.key, input.sourceLocale, source, issues)
    if (
      input.fallbackLocale &&
      input.fallbackLocale !== input.sourceLocale &&
      !entry.values[input.fallbackLocale]
    ) {
      issues.push(
        issue(
          entry.key,
          input.fallbackLocale,
          'fallback_translation_missing',
          'blocker',
          'Fallback translation is required',
        ),
      )
    }
    for (const locale of input.locales) {
      const value = entry.values[locale]
      if (!value) {
        issues.push(
          issue(entry.key, locale, 'empty_translation', 'warning', 'Translation is missing'),
        )
        continue
      }
      if (entry.characterLimit && [...value].length > entry.characterLimit) {
        issues.push(
          issue(
            entry.key,
            locale,
            'character_limit',
            'blocker',
            `Translation is ${[...value].length - entry.characterLimit} characters over the ${entry.characterLimit} character limit`,
          ),
        )
      }
      if (/^\s/.test(value) && !/^\s/.test(source))
        issues.push(
          issue(
            entry.key,
            locale,
            'leading_whitespace',
            'warning',
            'Unexpected leading whitespace',
          ),
        )
      if (/\s$/.test(value) && !/\s$/.test(source))
        issues.push(
          issue(
            entry.key,
            locale,
            'trailing_whitespace',
            'warning',
            'Unexpected trailing whitespace',
          ),
        )

      const targetContract = tryContract(entry.key, locale, value, issues)
      if (!sourceContract || !targetContract) continue
      compareContract(entry.key, locale, sourceContract, targetContract, issues)
    }
  }
  return issues
}

export function pseudoLocalizeIcu(message: string): string {
  const ast = parse(message)
  transformLiterals(ast)
  return `［${printAST(ast)}］`
}

function walk(
  elements: MessageFormatElement[],
  visit: (element: MessageFormatElement) => void,
): void {
  for (const element of elements) {
    visit(element)
    if (isPluralElement(element) || isSelectElement(element)) {
      for (const option of Object.values(element.options)) walk(option.value, visit)
    } else if (isTagElement(element)) walk(element.children, visit)
  }
}

function transformLiterals(elements: MessageFormatElement[]): void {
  walk(elements, (element) => {
    if (isLiteralElement(element)) element.value = pseudoLocalizeText(element.value)
  })
}

export function pseudoLocalizeText(value: string): string {
  const accents: Record<string, string> = {
    a: 'á',
    b: 'ƀ',
    c: 'ç',
    d: 'đ',
    e: 'ë',
    f: 'ƒ',
    g: 'ğ',
    h: 'ħ',
    i: 'ï',
    j: 'ĵ',
    k: 'ķ',
    l: 'ľ',
    m: 'ɱ',
    n: 'ñ',
    o: 'ô',
    p: 'þ',
    q: 'ɋ',
    r: 'ŕ',
    s: 'š',
    t: 'ŧ',
    u: 'ü',
    v: 'ṽ',
    w: 'ŵ',
    x: 'ẋ',
    y: 'ÿ',
    z: 'ž',
  }
  const mapped = [...value]
    .map((character) => {
      const replacement = accents[character.toLowerCase()]
      return replacement && character === character.toUpperCase()
        ? replacement.toUpperCase()
        : (replacement ?? character)
    })
    .join('')
  const letters = [...mapped].filter((character) => /[\p{L}]/u.test(character)).length
  return mapped + '~'.repeat(Math.ceil(letters * 0.3))
}

function tryContract(
  key: string,
  locale: string,
  value: string,
  issues: QaIssue[],
): IcuContract | undefined {
  try {
    return analyzeIcuMessage(value)
  } catch (error) {
    issues.push(
      issue(
        key,
        locale,
        'icu_syntax',
        'blocker',
        error instanceof Error ? error.message : 'Invalid ICU MessageFormat syntax',
      ),
    )
    return undefined
  }
}

function compareContract(
  key: string,
  locale: string,
  source: IcuContract,
  target: IcuContract,
  issues: QaIssue[],
): void {
  for (const [name, kind] of Object.entries(source.arguments)) {
    if (!target.arguments[name])
      issues.push(
        issue(key, locale, 'argument_missing', 'blocker', `ICU argument "${name}" is missing`),
      )
    else if (target.arguments[name] !== kind)
      issues.push(
        issue(
          key,
          locale,
          'argument_type',
          'blocker',
          `ICU argument "${name}" must be ${kind}, not ${target.arguments[name]}`,
        ),
      )
  }
  for (const name of Object.keys(target.arguments)) {
    if (!source.arguments[name])
      issues.push(
        issue(key, locale, 'argument_extra', 'blocker', `Unexpected ICU argument "${name}"`),
      )
  }
  if (source.tags.join('\0') !== target.tags.join('\0'))
    issues.push(
      issue(key, locale, 'tag_mismatch', 'blocker', 'Rich-text tags do not match the source'),
    )
}

function issue(
  key: string,
  locale: string,
  code: QaIssue['code'],
  severity: QaSeverity,
  message: string,
): QaIssue {
  return { key, locale, code, severity, message }
}
