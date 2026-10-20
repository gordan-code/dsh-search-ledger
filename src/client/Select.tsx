import React, { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

interface Item { value: string; label: string; disabled: boolean }
interface SelectProps {
  value: string
  onValueChange(value: string): void
  children: React.ReactNode
  disabled?: boolean
  className?: string
  id?: string
  'aria-label': string
  'aria-describedby'?: string
}

function text(node: React.ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: React.ReactNode }>(child) ? text(child.props.children) : String(child)).join('')
}
function itemsOf(children: React.ReactNode): Item[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: React.ReactNode; value?: string; label?: string; disabled?: boolean }>(child)) return []
    if (child.type === Fragment) return itemsOf(child.props.children)
    if (child.type !== 'option') return []
    return [{ value: child.props.value ?? text(child.props.children), label: child.props.label ?? text(child.props.children), disabled: !!child.props.disabled }]
  })
}

/** 页面内菜单，不创建系统select弹窗；展开与键盘导航不提交业务更改。 */
export function Select({ value, onValueChange, children, disabled = false, className = '', id, ...aria }: SelectProps) {
  const items = useMemo(() => itemsOf(children), [children])
  const optionsKey = useMemo(() => JSON.stringify(items), [items])
  const listId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [navigation, setNavigation] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [rowHeight, setRowHeight] = useState(36)
  const typed = useRef({ value: '', at: 0 })
  const selected = useMemo(() => items.findIndex(item => item.value === value), [items, value])
  const hasEnabled = useMemo(() => items.some(item => !item.disabled), [items])
  const blocked = disabled || !hasEnabled
  const virtual = items.length > 80
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - 3) : 0
  const end = virtual ? Math.min(items.length, start + 22) : items.length

  useEffect(() => { setOpen(false); typed.current = { value: '', at: 0 } }, [disabled, value, optionsKey])

  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return
    const element = menu.current
    // Popover是DOM顶层，不开启系统窗口，也不额外引入宿主react-dom实例。
    if (typeof element.showPopover === 'function') {
      element.setAttribute('popover', 'manual')
      element.showPopover()
    }
    const rect = trigger.current.getBoundingClientRect()
    const scale = trigger.current.offsetHeight ? rect.height / trigger.current.offsetHeight : 1
    const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth
    const row = 36 * factor
    const below = viewportHeight - rect.bottom - 8
    const above = rect.top - 8
    const upwards = below < Math.min(8 * row, items.length * row) && above > below
    const height = Math.max(row, Math.min(8 * row, (upwards ? above : below) - 4))
    const width = Math.min(Math.max(rect.width, 120), Math.max(0, viewportWidth - 16))
    // 抵消宿主容器CSS zoom，菜单坐标统一使用视口物理CSS像素。
    element.style.zoom = String(1 / factor)
    element.style.fontSize = `${parseFloat(getComputedStyle(trigger.current).fontSize || '14') * factor}px`
    element.style.width = `${width}px`
    element.style.maxHeight = `${height}px`
    element.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`
    if (upwards) { element.style.top = 'auto'; element.style.bottom = `${Math.max(8, viewportHeight - rect.top + 4)}px` }
    else { element.style.top = `${Math.max(8, rect.bottom + 4)}px`; element.style.bottom = 'auto' }
    setRowHeight(row)
    const outside = (event: Event) => {
      const node = event.target
      if (node instanceof Node && !element.contains(node) && !trigger.current?.contains(node)) setOpen(false)
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) return
      const current = trigger.current?.getBoundingClientRect()
      // 自动滚到触发器后可能才收到scroll事件；位置未变时不误关刚打开的菜单。
      if (!current || Math.abs(current.top - rect.top) > 1 || Math.abs(current.left - rect.left) > 1) setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.visualViewport?.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.visualViewport?.removeEventListener('resize', close)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !menu.current || active < 0) return
    const element = menu.current
    const top = active * rowHeight
    const height = element.clientHeight || 8 * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + height) element.scrollTop = top + rowHeight - height
    setScrollTop(element.scrollTop)
  }, [active, open, rowHeight, navigation])

  const first = () => items.findIndex(item => !item.disabled)
  const last = () => items.findLastIndex(item => !item.disabled)
  const show = (index = selected >= 0 ? selected : value ? -1 : first()) => {
    if (blocked) return
    trigger.current?.focus({ preventScroll: true })
    setActive(index); setNavigation(previous => previous + 1); setOpen(true)
  }
  const choose = (index: number) => {
    const item = items[index]
    if (blocked || !open) return
    setOpen(false); trigger.current?.focus({ preventScroll: true })
    if (item && !item.disabled && item.value !== value) onValueChange(item.value)
  }
  const keyDown = (event: React.KeyboardEvent) => {
    if (blocked || event.nativeEvent.isComposing) return
    const key = event.key
    if (key === 'Tab') { setOpen(false); return }
    if (key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false) }; return }
    if (key === 'Enter' || key === ' ') { event.preventDefault(); if (open) choose(active); else show(); return }
    if (key === 'Home' || key === 'End') { event.preventDefault(); show(key === 'Home' ? first() : last()); return }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { show(); return }
      const direction = key === 'ArrowDown' ? 1 : -1
      const base = active < 0 && direction < 0 ? items.length : active
      for (let i = base + direction; i >= 0 && i < items.length; i += direction) {
        if (!items[i]!.disabled) { setActive(i); setNavigation(previous => previous + 1); break }
      }
      return
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now()
      const query = now - typed.current.at > 700 ? key : typed.current.value + key
      typed.current = { value: query.toLocaleLowerCase(), at: now }
      const repeated = [...query].every(char => char.toLocaleLowerCase() === key.toLocaleLowerCase())
      const prefix = repeated ? key.toLocaleLowerCase() : query.toLocaleLowerCase()
      const base = open ? active : selected
      for (let offset = 1; offset <= items.length; offset++) {
        const index = (Math.max(-1, base) + offset) % items.length
        if (!items[index]!.disabled && items[index]!.label.toLocaleLowerCase().startsWith(prefix)) { show(index); break }
      }
    }
  }

  // 活动项始终保留在窗口中，使aria-activedescendant不指向未挂载节点。
  const visible = Array.from({ length: end - start }, (_, i) => start + i)
  if (virtual && active >= 0 && !visible.includes(active)) visible.push(active)
  return <span className={`dsh-select ${className}`.trim()}>
    <button {...aria} id={id} ref={trigger} type="button" role="combobox" aria-haspopup="listbox"
      aria-expanded={open && !blocked} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      className="dsh-select-trigger" disabled={blocked} value={value} onKeyDown={keyDown}
      onClick={() => { if (open) setOpen(false); else show() }}>
      <span>{selected >= 0 ? items[selected]!.label : value ? `未配置（${value}）` : '暂无可选项'}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && !blocked && <div ref={menu} id={listId} className="dsh-select-menu" role="listbox" aria-label={`${aria['aria-label']}选项`}
      onPointerDown={event => event.preventDefault()} onScroll={event => { if (virtual) setScrollTop(event.currentTarget.scrollTop) }}>
      <div className="dsh-select-options" style={virtual ? { height: items.length * rowHeight, position: 'relative' } : undefined}>
        {visible.map(index => {
          const item = items[index]!
          return <div key={index} id={`${listId}-${index}`} role="option" aria-selected={item.value === value} aria-disabled={item.disabled || undefined}
            aria-posinset={index + 1} aria-setsize={items.length} title={item.label} data-value={item.value}
            className={`dsh-select-option${active === index ? ' dsh-select-active' : ''}`}
            style={{ height: rowHeight, ...(virtual ? { position: 'absolute', top: index * rowHeight, left: 0, right: 0 } : {}) }}
            onPointerMove={() => { if (!item.disabled) setActive(index) }}
            onClick={event => { event.preventDefault(); event.stopPropagation(); choose(index) }}>{item.label}</div>
        })}
      </div>
    </div>}
  </span>
}
