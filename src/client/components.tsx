import React, { type ReactNode } from 'react'

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'danger' | 'neutral' }) {
  return <span className={`dsh-badge dsh-badge-${tone}`}>{children}</span>
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="dsh-empty"><strong>{title}</strong>{children && <span>{children}</span>}</div>
}

export function SectionCard({ title, description, actions, children, className = '' }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`dsh-card ${className}`.trim()}>
    <div className="dsh-card-header">
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {actions && <div className="dsh-card-actions">{actions}</div>}
    </div>
    {children}
  </section>
}

export function RouteBadge({ ready, reason }: { ready: boolean; reason?: string | null }) {
  return <Badge tone={ready ? 'success' : reason ? 'warning' : 'neutral'}>{ready ? '默认渠道已配置' : reason || '未绑定'}</Badge>
}
