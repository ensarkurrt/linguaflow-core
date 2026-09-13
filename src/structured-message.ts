import { analyzeIcuMessage, pseudoLocalizeText, type IcuContract } from './icu.js'
import {
  isArgumentElement,
  isLiteralElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser'

export type StructuredMessage = { nodes: MessageNode[] }

export type MessageNode =
  | { type: 'text'; value: string }
  | { type: 'argument'; name: string }
  | { type: 'pound' }
  | {
      type: 'plural'
      argument: string
      offset?: number | undefined
      variants: Record<string, StructuredMessage>
    }
  | { type: 'select'; argument: string; variants: Record<string, StructuredMessage> }

export type CompiledStructuredMessage = {
  value: string
  contract: IcuContract
}

const argumentPattern = /^[a-zA-Z][a-zA-Z0-9_]*$/
const selectKeyPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const pluralKeyPattern = /^(?:zero|one|two|few|many|other|=[0-9]+)$/

export function compileStructuredMessage(message: StructuredMessage): CompiledStructuredMessage {
  const value = compileNodes(message.nodes, false, 0)
  return { value, contract: analyzeIcuMessage(value) }
}

/** Converts the portable ICU subset into the same structured blocks produced by the visual editor. */
export function parseStructuredMessage(value: string): StructuredMessage {
  return { nodes: parse(value).map(toMessageNode) }
}

/** Pseudo-localizes only literal UI text while preserving every ICU control block. */
export function pseudoLocalizeStructuredMessage(message: StructuredMessage): StructuredMessage {
  return {
    nodes: [
      { type: 'text', value: '［' },
      ...message.nodes.map(pseudoLocalizeNode),
      { type: 'text', value: '］' },
    ],
  }
}

function pseudoLocalizeNode(node: MessageNode): MessageNode {
  if (node.type === 'text') return { type: 'text', value: pseudoLocalizeText(node.value) }
  if (node.type === 'plural' || node.type === 'select') {
    return {
      ...node,
      variants: Object.fromEntries(
        Object.entries(node.variants).map(([key, message]) => [
          key,
          { nodes: message.nodes.map(pseudoLocalizeNode) },
        ]),
      ),
    }
  }
  return { ...node }
}

function toMessageNode(element: MessageFormatElement): MessageNode {
  if (isLiteralElement(element)) return { type: 'text', value: element.value }
  if (isArgumentElement(element)) return { type: 'argument', name: element.value }
  if (isPoundElement(element)) return { type: 'pound' }
  if (isPluralElement(element)) {
    if (element.pluralType !== 'cardinal') {
      throw new SyntaxError('selectordinal is not supported by the Flutter runtime yet')
    }
    return {
      type: 'plural',
      argument: element.value,
      ...(element.offset ? { offset: element.offset } : {}),
      variants: Object.fromEntries(
        Object.entries(element.options).map(([key, option]) => [
          key,
          { nodes: option.value.map(toMessageNode) },
        ]),
      ),
    }
  }
  if (isSelectElement(element)) {
    return {
      type: 'select',
      argument: element.value,
      variants: Object.fromEntries(
        Object.entries(element.options).map(([key, option]) => [
          key,
          { nodes: option.value.map(toMessageNode) },
        ]),
      ),
    }
  }
  throw new SyntaxError('ICU number, date, time and rich-text tags are not supported yet')
}

function compileNodes(nodes: MessageNode[], withinPlural: boolean, depth: number): string {
  if (depth > 12) throw new SyntaxError('Structured messages can be nested at most 12 levels')
  if (!nodes.length) throw new SyntaxError('A message must contain at least one block')
  return nodes.map((node) => compileNode(node, withinPlural, depth)).join('')
}

function compileNode(node: MessageNode, withinPlural: boolean, depth: number): string {
  switch (node.type) {
    case 'text':
      if (!node.value) throw new SyntaxError('Text blocks cannot be empty')
      return escapeIcuLiteral(node.value, withinPlural)
    case 'argument':
      assertArgumentName(node.name)
      return `{${node.name}}`
    case 'pound':
      if (!withinPlural)
        throw new SyntaxError('Pound blocks can only be used inside plural variants')
      return '#'
    case 'plural':
      return compileChoice(
        node.argument,
        'plural',
        node.variants,
        node.offset ?? 0,
        true,
        depth + 1,
      )
    case 'select':
      return compileChoice(node.argument, 'select', node.variants, 0, withinPlural, depth + 1)
  }
}

function compileChoice(
  argument: string,
  type: 'plural' | 'select',
  variants: Record<string, StructuredMessage>,
  offset: number,
  withinPlural: boolean,
  depth: number,
): string {
  assertArgumentName(argument)
  if (!Object.hasOwn(variants, 'other')) {
    throw new SyntaxError(`${type} blocks require an other variant`)
  }
  if (type === 'plural' && (!Number.isInteger(offset) || offset < 0)) {
    throw new SyntaxError('Plural offset must be a non-negative integer')
  }
  const options = Object.entries(variants)
  if (!options.length) throw new SyntaxError(`${type} blocks require at least one variant`)
  const rendered = options.map(([key, message]) => {
    const valid = type === 'plural' ? pluralKeyPattern.test(key) : selectKeyPattern.test(key)
    if (!valid) throw new SyntaxError(`Invalid ${type} variant: ${key}`)
    return `${key} {${compileNodes(message.nodes, type === 'plural' || withinPlural, depth)}}`
  })
  const offsetClause = type === 'plural' && offset > 0 ? ` offset:${offset}` : ''
  return `{${argument}, ${type},${offsetClause} ${rendered.join(' ')}}`
}

function assertArgumentName(name: string): void {
  if (!argumentPattern.test(name)) throw new SyntaxError(`Invalid ICU argument name: ${name}`)
}

function escapeIcuLiteral(value: string, withinPlural: boolean): string {
  return value
    .replaceAll("'", "''")
    .replaceAll('{', "'{'")
    .replaceAll('}', "'}'")
    .replaceAll('#', withinPlural ? "'#'" : '#')
}
