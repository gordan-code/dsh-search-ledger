import { fireEvent, screen } from '@testing-library/react'

/** 用实际点击迁移下拉交互测试，不依赖原生select.value的合成change。 */
export function changeControl(element: Element, event: { target: { value: string } }): void {
  if (element.getAttribute('role') !== 'combobox') { fireEvent.change(element, event); return }
  if ((element as HTMLButtonElement).disabled) return
  fireEvent.click(element)
  const item = screen.queryAllByRole('option').find(option => option.getAttribute('data-value') === event.target.value)
  if (!item) throw new Error(`未找到下拉选项：${event.target.value}`)
  fireEvent.click(item)
}
