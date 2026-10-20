import type { BillingPolicy, Decision, Evidence, Operation } from '../contracts.ts'

function resultEvidence(operation: Operation, evidence: Evidence): Decision {
  const payload = evidence.payload
  if (operation === 'search') {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) {
      return { outcome: 'unknown' }
    }
    const results = (payload as { results: unknown[] }).results
    return { outcome: results.length > 0 ? 'billable' : 'empty', resultCount: results.length, hasContent: results.length > 0 }
  }

  if (!payload || typeof payload !== 'object' || typeof (payload as { content?: unknown }).content !== 'string') {
    return { outcome: 'unknown' }
  }
  const content = (payload as { content: string }).content
  const hasContent = content.trim().length > 0
  return { outcome: hasContent ? 'billable' : 'empty', hasContent }
}

function evidenceDecision(operation: Operation, evidence: Evidence): Decision | undefined {
  const billing = evidence.billingEvidence
  if (billing === undefined) return undefined
  if (billing.state === 'unknown') return { outcome: 'unknown' }
  if (billing.state === 'failed') return { outcome: 'failed', ...(billing.resultCount === undefined ? {} : { resultCount: billing.resultCount }), ...(billing.hasContent === undefined ? {} : { hasContent: billing.hasContent }) }
  if (billing.state === 'empty') return { outcome: 'empty', ...(billing.resultCount === undefined ? {} : { resultCount: billing.resultCount }), ...(billing.hasContent === undefined ? {} : { hasContent: billing.hasContent }) }
  const empty = operation === 'search' ? billing.resultCount === 0 : billing.hasContent === false
  return { outcome: empty ? 'empty' : 'billable', ...(billing.resultCount === undefined ? {} : { resultCount: billing.resultCount }), ...(billing.hasContent === undefined ? {} : { hasContent: billing.hasContent }) }
}

/**
 * 仅依据原始协议证据决定一次调用的记账状态。
 * transportUnknown 优先于 HTTP 状态，避免把中途断连误判为失败或免费。
 */
export function decide(operation: Operation, policy: BillingPolicy, evidence: Evidence): Decision {
  if (evidence.transportUnknown === true) return { outcome: 'unknown' }
  const providerEvidence = evidenceDecision(operation, evidence)
  // 服务商逐条证据优先于HTTP 200；HTTP 200中的业务失败/未知不能绕过证据层。
  if (providerEvidence?.outcome === 'failed' || providerEvidence?.outcome === 'unknown') return providerEvidence
  if (evidence.status !== 200) {
    return typeof evidence.status === 'number' ? { outcome: 'failed' } : { outcome: 'unknown' }
  }
  if (policy === 'provider-success') {
    if (providerEvidence === undefined) return { outcome: 'unknown' }
    return evidence.billingEvidence?.state === 'success' ? { ...providerEvidence, outcome: 'billable' } : providerEvidence
  }
  if (policy === 'http-200') return { outcome: 'billable' }
  if (policy === 'official-nonempty' || policy === 'free') return providerEvidence ?? resultEvidence(operation, evidence)
  return { outcome: 'unknown' }
}
