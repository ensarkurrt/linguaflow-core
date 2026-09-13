export type ExchangeStatus =
  'machine_translated' | 'translated' | 'in_review' | 'approved' | 'rejected'

export type ExchangeEntry = {
  key: string
  values: Record<string, string>
  statuses?: Record<string, string>
  description?: string
  context?: string
  characterLimit?: number | null
}

export type ExchangeTranslation = {
  key: string
  locale: string
  value: string
  status?: ExchangeStatus
  description?: string
  context?: string
  characterLimit?: number | null
}
