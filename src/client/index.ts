// 先挂载本包严格Remote贡献，再装配依赖该命名空间的配置页面，避免启动死锁。
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'
import { App } from './App.tsx'
import { billingApi } from './remote.ts'
import type { RoutingConfig } from '../contracts.ts'
export const inject = ['remote']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE))
  ctx.plugin({
    name: 'web-search-billing-panel', inject: ['remote.webSearchBilling', 'slots', 'configForms'],
    apply(child: Context) {
      const form = child.configForms.get<RoutingConfig>('web-search-billing')
      const api = billingApi(child.remote.webSearchBilling)
      const Panel = () => React.createElement(App, { api, form })
      // 挂到设置侧边栏（settings.section），与「通用/模型/插件」并列，而不是插件管理器的内置插件列表。
      child.effect(() => child.configForms.whileServed(['web-search-billing'], () => child.slots.inject('settings.section', () => child.slots.register({ name: 'settings.section', id: 'web-search-billing', order: 21, label: () => '搜索渠道与费用' }, Panel))))
    },
  })
}
