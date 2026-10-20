// 用行为验证跟随、覆盖与快照，避免只测试配置对象。
import { describe, it, expect } from 'vitest'
import { resolveRoute, parseRoutingConfig, DEFAULT_CONFIG } from '../../src/routing/resolver.ts'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
const channel = (id: string) => ({ id, name: id, kind: 'deepseek-api', billingClass: 'relay', enabled: true, endpointBase: `https://${id}.example/v1/tools`, credentialRef: 'TEST_KEY', capabilities: ['search', 'fetch'], prices: { search: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' }, fetch: { perThousand: null, currency: 'CNY', policy: 'official-nonempty' } } })
const input = () => parseRoutingConfig({ channels: [channel('a'), channel('b')], providerBindings: { relay: { search: 'a', fetch: 'b' } }, globalOverrides: {} })
const source = { profileId: 'p', sessionId: 's', sourceProviderId: 'relay' }
describe('路由', () => {
  it('凭证引用语法与宿主一致，无效引用不能保存', () => {
    for (const ref of ['VALID_KEY', '_key123', 'foo-bar', '123key', 'bad key']) {
      const config = input(); config.channels[0].credentialRef = ref
      if (isCredentialRefName(ref)) expect(() => parseRoutingConfig(config)).not.toThrow()
      else expect(() => parseRoutingConfig(config)).toThrow()
    }
  })
  it('跟随实际provider且search和fetch独立', () => {
    expect(resolveRoute(input(), source, 'search').channel.id).toBe('a')
    expect(resolveRoute(input(), source, 'fetch').channel.id).toBe('b')
  })
  it('会话覆盖优先于全局覆盖与绑定，并冻结快照', () => {
    const config = input(); config.globalOverrides.search = 'b'
    const route = resolveRoute(config, source, 'search', { search: 'a' })
    config.channels[0].name = '修改后'
    expect(route.channel.name).toBe('a'); expect(route.routeSource).toBe('session')
  })
  it('没有来源时只允许显式全局覆盖，禁止借用其他会话', () => {
    expect(() => resolveRoute(input(), { profileId: 'p' }, 'search')).toThrow('未绑定')
    const config = input(); config.globalOverrides.search = 'a'
    expect(resolveRoute(config, { profileId: 'p' }, 'search').channel.id).toBe('a')
  })
  it('默认不偷偷发出收费请求', () => expect(() => resolveRoute(DEFAULT_CONFIG, source, 'search')).toThrow('未绑定'))
  it('官方渠道禁止配置按空200收费，渠道ID必须唯一', () => {
    const config = input(); config.channels[0].billingClass = 'official'
    expect(() => parseRoutingConfig(config)).toThrow()
    config.channels[0].billingClass = 'relay'; config.channels.push(config.channels[0])
    expect(() => parseRoutingConfig(config)).toThrow('重复')
  })
})
