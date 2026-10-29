// volatile字段交给宿主设置表单，执行前再做完整业务校验。
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { RoutingConfig } from './contracts.ts'
import { DEFAULT_CONFIG, parseRoutingConfig } from './routing/resolver.ts'
export interface Config {
  channels: Volatile<RoutingConfig['channels']>
  providerBindings: Volatile<RoutingConfig['providerBindings']>
  globalOverrides: Volatile<RoutingConfig['globalOverrides']>
  failover?: Volatile<NonNullable<RoutingConfig['failover']>>
  breaker?: Volatile<NonNullable<RoutingConfig['breaker']>>
  budget?: Volatile<NonNullable<RoutingConfig['budget']>>
}
export const Config: z = z.object({
  channels: z.array(z.any()).default(DEFAULT_CONFIG.channels).volatile(),
  providerBindings: z.dict(z.any()).default({}).volatile(),
  globalOverrides: z.dict(z.any()).default({}).volatile(),
  failover: z.dict(z.any()).default({}).volatile(),
  breaker: z.dict(z.any()).default({}).volatile(),
  budget: z.dict(z.any()).default({}).volatile(),
})
export function readConfig(config: Config): RoutingConfig {
  return parseRoutingConfig({
    channels: config.channels.get(), providerBindings: config.providerBindings.get(), globalOverrides: config.globalOverrides.get(),
    ...(config.failover === undefined ? {} : { failover: config.failover.get() }),
    ...(config.breaker === undefined ? {} : { breaker: config.breaker.get() }),
    ...(config.budget === undefined ? {} : { budget: config.budget.get() }),
  })
}
