// Host与浏览器共用业务校验，浏览器不可导入任何Node模块。
import { z } from 'zod'
import { BillingError } from './contracts.ts'
import type { RoutingConfig } from './contracts.ts'
const price = z.object({ perThousand: z.string().regex(/^\d+(\.\d{1,3})?$/).max(15).nullable(), currency: z.enum(['CNY', 'USD']), policy: z.enum(['official-nonempty', 'http-200', 'free', 'provider-success']) }).strict()
const selections = z.object({ search: z.string().nullable().optional(), fetch: z.string().nullable().optional() }).strict()
const failoverSettings = z.object({
  enabled: z.boolean().default(false),
  attemptTimeoutMs: z.number().int().min(1).max(30_000).default(20_000),
  totalTimeoutMs: z.number().int().min(1).max(300_000).default(60_000),
}).strict()
const breakerSettings = z.object({
  enabled: z.boolean().default(false),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  windowMs: z.number().int().min(10_000).max(86_400_000).default(300_000),
  cooldownMs: z.number().int().min(10_000).max(86_400_000).default(600_000),
}).strict()
// 金额以十进制字符串承载，避免二进制浮点误差；币种分别限额，不做汇率折算。
const microsText = z.string().regex(/^\d+(\.\d{1,6})?$/).max(20)
const budgetSettings = z.object({
  enabled: z.boolean().default(false),
  window: z.enum(['day', 'month']).default('day'),
  limits: z.object({ CNY: microsText.nullable().optional(), USD: microsText.nullable().optional() }).strict().default({}),
  requests: z.number().int().min(1).max(1_000_000).nullable().default(null),
  onExceed: z.enum(['warn', 'block', 'fallback']).default('warn'),
}).strict()
const schema = z.object({ channels: z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1).max(120),
  kind: z.enum(['deepseek-api', 'searxng', 'tavily', 'local-http', 'tinyfish', 'qianfan']),
  billingClass: z.enum(['official', 'relay', 'free', 'service']), enabled: z.boolean(), archived: z.boolean().optional(),
  endpointBase: z.string().max(2048), credentialRef: z.string().min(1).max(160).optional(), allowHttp: z.boolean().optional(),
  capabilities: z.array(z.enum(['search', 'fetch'])).min(1), prices: z.object({ search: price.optional(), fetch: price.optional() }).strict(),
  monthlyCredits: z.number().int().min(0).max(1000).optional(),
}).strict()).max(100), providerBindings: z.record(z.string().min(1).max(160), selections).default({}), globalOverrides: selections.default({}),
  failover: z.object({ search: failoverSettings.optional(), fetch: failoverSettings.optional() }).strict().optional(),
  breaker: breakerSettings.optional(),
  budget: budgetSettings.optional(),
}).strict()
export const DEFAULT_CONFIG: RoutingConfig = { channels: [
  { id: 'deepseek-official-api', name: 'DeepSeek 官方 API', kind: 'deepseek-api', billingClass: 'official', enabled: true, endpointBase: 'https://api.deepseek.com/v1/tools', credentialRef: 'DEEPSEEK_API_KEY', capabilities: ['search', 'fetch'], prices: { search: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' }, fetch: { perThousand: '5', currency: 'CNY', policy: 'official-nonempty' } } },
  { id: 'local-http', name: '本地 HTTP 抓取', kind: 'local-http', billingClass: 'free', enabled: true, endpointBase: '', capabilities: ['fetch'], prices: { fetch: { perThousand: '0', currency: 'CNY', policy: 'free' } } },
], providerBindings: {}, globalOverrides: {} }
export function parseRoutingConfig(input: unknown): RoutingConfig {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new BillingError('CONFIG_INVALID', '渠道字段、费率或操作配置无效')
  const config = parsed.data as RoutingConfig; const ids = new Set<string>()
  for (const channel of config.channels) {
    if (ids.has(channel.id)) throw new BillingError('CONFIG_INVALID', '渠道ID重复')
    ids.add(channel.id)
    if (channel.archived && channel.enabled) throw new BillingError('CONFIG_INVALID', '已删除渠道不能重新启用，请使用新渠道ID')
    if (channel.credentialRef && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel.credentialRef)) throw new BillingError('CONFIG_INVALID', '凭证引用须为字母或下划线开头的POSIX标识符')
    if (channel.kind !== 'local-http') {
      let url: URL
      try { url = new URL(channel.endpointBase) } catch { throw new BillingError('CONFIG_INVALID', '渠道地址无效') }
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(channel.kind === 'searxng' && channel.allowHttp && url.protocol === 'http:'))) throw new BillingError('CONFIG_INVALID', '渠道地址须使用HTTPS且不得内嵌凭证、查询或片段')
      if (channel.billingClass === 'official' && (channel.kind !== 'deepseek-api' || url.origin !== 'https://api.deepseek.com')) throw new BillingError('CONFIG_INVALID', '官方分类必须使用官方地址')
      if (channel.kind === 'tavily' && url.origin !== 'https://api.tavily.com') throw new BillingError('CONFIG_INVALID', 'Tavily仅允许官方API地址')
      if (channel.kind === 'tinyfish' && (url.origin !== 'https://api.search.tinyfish.ai' || url.pathname !== '/')) throw new BillingError('CONFIG_INVALID', 'TinyFish地址必须使用官方Search地址')
      if (channel.kind === 'qianfan' && (url.origin !== 'https://qianfan.baidubce.com' || !['/v2/ai_search', '/v2/ai_search/web_search'].includes(url.pathname))) throw new BillingError('CONFIG_INVALID', '千帆地址必须使用官方Search地址')
    }
    if (channel.kind === 'deepseek-api' && !['official', 'relay'].includes(channel.billingClass)) throw new BillingError('CONFIG_INVALID', 'DeepSeek渠道计费分类无效')
    if (['tinyfish', 'qianfan'].includes(channel.kind) && channel.billingClass !== 'service') throw new BillingError('CONFIG_INVALID', '该服务渠道必须使用service分类')
    if (channel.kind === 'tavily' && !['free', 'service'].includes(channel.billingClass)) throw new BillingError('CONFIG_INVALID', 'Tavily渠道计费分类无效')
    if (['searxng', 'local-http'].includes(channel.kind) && channel.billingClass !== 'free') throw new BillingError('CONFIG_INVALID', '匿名渠道必须使用free分类')
    for (const op of channel.capabilities) {
      if ((channel.kind === 'local-http' && op !== 'fetch') || (channel.kind === 'qianfan' && op !== 'search') || (channel.kind === 'searxng' && op !== 'search')) throw new BillingError('CONFIG_INVALID', '渠道不支持该能力')
      const p = channel.prices[op]
      if (!p || (channel.billingClass === 'official' && p.policy !== 'official-nonempty') || (channel.billingClass === 'free' && (p.policy !== 'free' || p.perThousand !== '0'))) throw new BillingError('CONFIG_INVALID', '价格或计费策略与渠道不符')
      if (channel.billingClass === 'service' && p.policy !== 'provider-success') throw new BillingError('CONFIG_INVALID', 'service渠道必须使用provider-success计费策略')
    }
  }
  if (config.budget?.enabled === true) {
    const limits = config.budget.limits
    // 允许 '0'：表示该币种一律不得产生费用。
    if ((limits.CNY ?? null) === null && (limits.USD ?? null) === null && config.budget.requests === null) throw new BillingError('CONFIG_INVALID', '预算已启用但未设置任何金额或次数上限')
  }
  return config
}
