import { BillingError } from '../contracts.ts'

/** 等待不合作的Promise时也响应取消；晚到结果只被消费，不触发新的副作用。 */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  const reason = () => signal.reason instanceof BillingError ? signal.reason : new BillingError('CANCELLED', '请求已取消')
  if (signal.aborted) { void promise.catch(() => undefined); throw reason() }
  let remove = () => {}
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(reason())
    signal.addEventListener('abort', abort, { once: true })
    remove = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) abort()
  })
  try { return await Promise.race([promise, stopped]) }
  finally { remove(); void promise.catch(() => undefined) }
}

export class OperationBudget {
  readonly controller = new AbortController()
  private readonly deadline: number
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly parentAbort: () => void
  constructor(private readonly totalMs: number, private readonly parent?: AbortSignal) {
    this.deadline = performance.now() + totalMs
    this.parentAbort = () => this.controller.abort(new BillingError('CANCELLED', '请求已取消'))
    parent?.addEventListener('abort', this.parentAbort, { once: true })
    this.timer = setTimeout(() => this.controller.abort(new BillingError('TOTAL_TIMEOUT', '渠道总时间预算已耗尽')), totalMs)
    if (parent?.aborted) this.parentAbort()
  }
  check(): void {
    if (this.parent?.aborted) this.parentAbort()
    if (!this.controller.signal.aborted && performance.now() >= this.deadline) this.controller.abort(new BillingError('TOTAL_TIMEOUT', '渠道总时间预算已耗尽'))
    if (this.controller.signal.aborted) throw this.controller.signal.reason
  }
  async attempt<T>(timeoutMs: number, run: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    this.check()
    const child = new AbortController()
    const deadline = performance.now() + timeoutMs
    const check = () => {
      this.check()
      if (!child.signal.aborted && performance.now() >= deadline) child.abort(new BillingError('ATTEMPT_TIMEOUT', '该渠道请求超时'))
      if (child.signal.aborted) throw child.signal.reason
    }
    const stop = () => child.abort(this.controller.signal.reason)
    this.controller.signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => child.abort(new BillingError('ATTEMPT_TIMEOUT', '该渠道请求超时')), timeoutMs)
    try { check(); return await run(child.signal, check) }
    finally { clearTimeout(timer); this.controller.signal.removeEventListener('abort', stop) }
  }
  close(): void { clearTimeout(this.timer); this.parent?.removeEventListener('abort', this.parentAbort) }
}

const retryable = new Set(['UPSTREAM_FAILED', 'UPSTREAM_UNKNOWN', 'RESULT_INVALID', 'ATTEMPT_TIMEOUT', 'QUOTA_LOCAL_LIMIT'])
export function mayFailover(error: unknown): boolean { return error instanceof BillingError && retryable.has(error.code) }
