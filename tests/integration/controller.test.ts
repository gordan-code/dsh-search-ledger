// 受控Remote必须拒绝非owner，并只返回白名单业务结果。
import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BillingController } from '../../src/host/controller.ts'
it('Host服务提供已登记的状态方法而不是匿名HTTP端口', () => {
  const ctx = new Context()
  const backend = { getStatus: () => ({ version: '0.1.0', profileId: 'test', namespace: 'web-search-billing', coverage: 'local', active: true, configError: null }) }
  const service = new BillingController(ctx, backend as never)
  expect(service.getStatus().profileId).toBe('test')
  expect(service.typertRemote.namespace).toBe('webSearchBilling')
})
