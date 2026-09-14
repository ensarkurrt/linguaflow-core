export const MAX_LOCALIZATION_DOCUMENT_BYTES = 6 * 1024 * 1024
export const MAX_LOCALIZATION_TREE_DEPTH = 32
export const MAX_LOCALIZATION_TREE_NODES = 100_000

type LocalizationTreeKind = 'Nested JSON' | 'YAML'

type PendingTreeNode = {
  value: Record<string, unknown>
  prefix: string
  depth: number
}

export function assertLocalizationDocumentSize(content: string): void {
  if (
    content.length > MAX_LOCALIZATION_DOCUMENT_BYTES ||
    new TextEncoder().encode(content).byteLength > MAX_LOCALIZATION_DOCUMENT_BYTES
  ) {
    throw new Error(`Localization document cannot exceed ${MAX_LOCALIZATION_DOCUMENT_BYTES} bytes`)
  }
}

export function flattenLocalizationTree(
  document: Record<string, unknown>,
  kind: LocalizationTreeKind,
): Record<string, string> {
  const flattened = Object.create(null) as Record<string, string>
  const pending: PendingTreeNode[] = [{ value: document, prefix: '', depth: 1 }]
  let visitedNodes = 0

  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.depth > MAX_LOCALIZATION_TREE_DEPTH) {
      throw new Error(`${kind} cannot exceed ${MAX_LOCALIZATION_TREE_DEPTH} levels`)
    }
    for (const [segment, value] of Object.entries(current.value)) {
      visitedNodes += 1
      if (visitedNodes > MAX_LOCALIZATION_TREE_NODES) {
        throw new Error(`${kind} cannot exceed ${MAX_LOCALIZATION_TREE_NODES} nodes`)
      }
      if (!segment) throw new Error(`${kind} keys cannot be empty`)
      const key = current.prefix ? `${current.prefix}.${segment}` : segment
      if (typeof value === 'string') {
        flattened[key] = value
      } else if (isRecord(value)) {
        pending.push({ value, prefix: key, depth: current.depth + 1 })
      } else {
        throw new Error(`${kind} value for "${key}" must be a string or object`)
      }
    }
  }

  return flattened
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
