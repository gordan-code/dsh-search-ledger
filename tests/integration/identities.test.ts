import { it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChannelIdentities } from '../../src/host/channel-identities.ts'
import { DEFAULT_CONFIG, resolveRoute } from '../../src/routing/resolver.ts'
import { BillingDatabase } from '../../src/storage/database.ts'
import { DatabaseSync } from 'node:sqlite'
import { MeteredWeb } from '../../src/accounting/meter.ts'
import type { Channel } from '../../src/contracts.ts'
it('同profile渠道身份跨重启冻结，改名改价不影响历史，其他profile独立', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'identity-')), 'usage.sqlite')
  const config = structuredClone(DEFAULT_CONFIG)
  config.globalOverrides.search = 'deepseek-official-api'
  const first = new ChannelIdentities(path)
  first.remember(resolveRoute(config, { profileId: 'p' }, 'search'))
  first.close()
  const second = new ChannelIdentities(path)
  const changed = structuredClone(config.channels)
  changed[0]!.name = '新名称'; changed[0]!.prices.search!.perThousand = '6'
  expect(() => second.assertConfig('p', changed)).not.toThrow()
  changed[0]!.endpointBase += '/new'
  expect(() => second.assertConfig('p', changed)).toThrow()
  expect(() => second.remember(resolveRoute({ ...config, channels: changed }, { profileId: 'p' }, 'search'))).toThrow()
  expect(() => second.assertConfig('other', changed)).not.toThrow()
  expect(() => second.assertConfig('p', [])).toThrow()
  second.close()
})
it('归档身份跨重启保留，直接配置写入不能取消归档或复用ID', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'retired-identity-')), 'usage.sqlite')
  const channels = structuredClone(DEFAULT_CONFIG.channels)
  channels[0]!.archived = true; channels[0]!.enabled = false
  const identities = new ChannelIdentities(path)
  identities.assertConfig('p', channels)
  identities.close()
  const restored = new ChannelIdentities(path)
  expect(() => restored.assertConfig('p', DEFAULT_CONFIG.channels)).toThrow()
  expect(() => restored.assertConfig('p', [])).toThrow()
  restored.close()
})
it('只有旧账本没有身份锁也不能移除/改源，首次保护读取后冻结完整身份', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'legacy-identity-')), 'usage.sqlite')
  const db = new BillingDatabase(path)
  db.prepare({ attemptId: 'legacy', operationId: 'o', ownerToken: 'owner', operation: 'search', profileId: 'p', channelId: 'deepseek-official-api', channelName: '旧记录', channelKind: 'deepseek-api', endpointOrigin: 'https://api.deepseek.com', price: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' }, configRevision: 'r', startedAt: new Date().toISOString() })
  const identities = new ChannelIdentities(path)
  expect(() => identities.assertConfig('p', [])).toThrow()
  identities.assertConfig('p', DEFAULT_CONFIG.channels)
  const changed = structuredClone(DEFAULT_CONFIG.channels); changed[0]!.endpointBase += '/changed'
  expect(() => identities.assertConfig('p', changed)).toThrow()
  identities.close(); db.close()
})

it('同一TinyFish渠道双操作记录真实origin，重启和无身份行legacy恢复均保留归属', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tinyfish-identity-')), 'usage.sqlite')
  const channel: Channel = { id: 'tiny', name: 'TinyFish', kind: 'tinyfish', billingClass: 'service', enabled: true, endpointBase: 'https://api.search.tinyfish.ai', credentialRef: 'TINY_KEY', capabilities: ['search', 'fetch'], prices: { search: { perThousand: null, currency: 'USD', policy: 'provider-success' }, fetch: { perThousand: null, currency: 'USD', policy: 'provider-success' } } }
  const config = { channels: [channel], providerBindings: {}, globalOverrides: { search: 'tiny', fetch: 'tiny' } }
  const db = new BillingDatabase(path); const identities = new ChannelIdentities(path)
  const meter = new MeteredWeb({ db, readConfig: () => config, source: () => ({ profileId: 'p' }), resolveCredential: async () => 'synthetic', quotaSubject: () => 'fp', afterPrepare: route => identities.remember(route), httpFetch: async input => new Response(JSON.stringify({ results: String(input).includes('api.fetch.') ? [{ url: 'https://page.example/', text: 'body' }] : [{ url: 'https://result.example/' }] })) })
  try { await meter.search({ query: 'q' }); await meter.fetch({ url: 'https://page.example/' }) } finally { identities.close(); db.close() }
  const reopened = new ChannelIdentities(path)
  try { expect(() => reopened.assertConfig('p', config.channels)).not.toThrow() } finally { reopened.close() }
  const raw = new DatabaseSync(path)
  try {
    expect(raw.prepare('SELECT operation,endpoint_origin FROM attempts ORDER BY operation').all()).toEqual([{ operation: 'fetch', endpoint_origin: 'https://api.fetch.tinyfish.ai' }, { operation: 'search', endpoint_origin: 'https://api.search.tinyfish.ai' }])
    raw.exec('DELETE FROM channel_identities')
  } finally { raw.close() }
  const legacy = new ChannelIdentities(path)
  try { expect(() => legacy.assertConfig('p', config.channels)).not.toThrow(); expect(legacy.isUsed('p', 'tiny')).toBe(true) } finally { legacy.close() }
})
