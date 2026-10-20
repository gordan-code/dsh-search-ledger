import { describe, expect, it } from 'vitest'
import type { Channel, RoutingConfig } from '../../src/contracts.ts'
import { parseRoutingConfig } from '../../src/config-schema.ts'
import { resolveCandidates } from '../../src/routing/candidates.ts'

const channel = (id: string, overrides: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  kind: 'tinyfish',
  billingClass: 'service',
  enabled: true,
  endpointBase: 'https://api.search.tinyfish.ai',
  credentialRef: 'TINYFISH_KEY',
  capabilities: ['search'],
  prices: { search: { perThousand: null, currency: 'USD', policy: 'provider-success' } },
  ...overrides,
})

const config = (channels: Channel[], failover?: RoutingConfig['failover']): RoutingConfig => ({
  channels,
  providerBindings: { source: { search: channels[1]?.id } },
  globalOverrides: {},
  ...(failover === undefined ? {} : { failover }),
})

describe('ordered route candidates', () => {
  it('keeps legacy single-route behavior while failover is disabled', () => {
    const input = config([channel('a'), channel('b')])
    expect(resolveCandidates(input, { profileId: 'p', sourceProviderId: 'source' }, 'search')).toHaveLength(1)
    expect(resolveCandidates(input, { profileId: 'p', sourceProviderId: 'source' }, 'search')[0].channel.id).toBe('b')
  })

  it('filters disabled/archived/incompatible channels, deduplicates preferred route, and freezes snapshots', () => {
    const input = config([
      channel('a', { enabled: false }),
      channel('b', { archived: true }),
      channel('c', { capabilities: ['fetch'], prices: { fetch: { perThousand: null, currency: 'USD', policy: 'provider-success' } } }),
      channel('d'),
      channel('e'),
    ], { search: { enabled: true, attemptTimeoutMs: 1000, totalTimeoutMs: 3000 } })
    input.providerBindings = { source: { search: 'd' } }
    const routes = resolveCandidates(input, { profileId: 'p', sourceProviderId: 'source' }, 'search')
    expect(routes.map(route => route.channel.id)).toEqual(['d', 'e'])
    expect(routes.map(route => route.routeSource)).toEqual(['binding', 'ordered'])
    expect(Object.isFrozen(routes)).toBe(true)
    expect(Object.isFrozen(routes[0].channel)).toBe(true)
  })

  it('puts only the winning session preference before configured order', () => {
    const input = config([channel('a'), channel('b'), channel('c')], { search: { enabled: true, attemptTimeoutMs: 1000, totalTimeoutMs: 3000 } })
    input.globalOverrides.search = 'b'
    input.providerBindings = { source: { search: 'c' } }
    const routes = resolveCandidates(input, { profileId: 'p', sessionId: 's', sourceProviderId: 'source' }, 'search', { search: 'a' })
    expect(routes.map(route => route.channel.id)).toEqual(['a', 'b', 'c'])
    expect(routes.map(route => route.routeSource)).toEqual(['session', 'ordered', 'ordered'])
    input.globalOverrides.search = 'c'
    const globalRoutes = resolveCandidates(input, { profileId: 'p', sourceProviderId: 'source' }, 'search')
    expect(globalRoutes.map(route => route.channel.id)).toEqual(['c', 'a', 'b'])
  })

  it('accepts the new service kinds without enabling failover by default', () => {
    const parsed = parseRoutingConfig({
      channels: [channel('tiny'), {
        id: 'qianfan', name: '千帆', kind: 'qianfan', billingClass: 'service', enabled: true,
        endpointBase: 'https://qianfan.baidubce.com/v2/ai_search/web_search', credentialRef: 'QIANFAN_KEY',
        capabilities: ['search'], prices: { search: { perThousand: null, currency: 'CNY', policy: 'provider-success' } },
      }],
      providerBindings: {}, globalOverrides: {},
    })
    expect(parsed.failover).toBeUndefined()
  })

  it('allows a missing credential reference so dispatch can skip it without prepare or HTTP', () => {
    const missing = channel('missing')
    delete missing.credentialRef
    expect(() => parseRoutingConfig({ channels: [missing], providerBindings: {}, globalOverrides: {} })).not.toThrow()
  })
})
