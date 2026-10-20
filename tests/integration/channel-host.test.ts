import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../../src/index.ts'
import { DEFAULT_CONFIG } from '../../src/config-schema.ts'
import { BillingDatabase } from '../../src/storage/database.ts'

it('真实Host把只有旧账本但无身份锁的渠道认定为已用并拒绝删除', async () => {
  const home = mkdtempSync(join(tmpdir(), 'billing-old-history-'))
  const ctx = new Context(); new TypertRegistry(ctx)
  ctx.provide('profileContext', { name: 'test', home })
  ctx.provide('credentials', { resolve: async () => undefined })
  new WebRuntime(ctx, { searchProvider: { get: () => 'web-search-metered' }, fetchProvider: { get: () => 'web-fetch-metered' } } as never)
  plugin.apply(ctx, Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, { get: () => value }])) as never)
  const db = new BillingDatabase(join(home, 'web-search-billing/usage.sqlite'))
  db.prepare({ attemptId: 'old-attempt', operationId: 'old-operation', ownerToken: 'old-owner', operation: 'search', profileId: 'test', channelId: 'deepseek-official-api', channelName: '历史官方渠道', channelKind: 'deepseek-api', endpointOrigin: 'https://api.deepseek.com', price: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' }, configRevision: 'old', startedAt: new Date().toISOString() })
  expect(ctx.webSearchBilling.listChannelStates().find(c => c.id === 'deepseek-official-api')).toMatchObject({ used: true, canDelete: false })
  await expect(ctx.webSearchBilling.deleteChannel('deepseek-official-api', 7)).rejects.toMatchObject({ code: 'CHANNEL_IN_USE' })
  expect(db.list('test').items[0]).toMatchObject({ channelName: '历史官方渠道', channelId: 'deepseek-official-api' })
  db.close()
})
