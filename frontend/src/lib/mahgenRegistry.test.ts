import { expect, it } from 'vitest'
import { applyMahgenSize, registerMahgen, unregisterMahgen } from './mahgenRegistry'

it('keeps teaching tiles stable when a short overlay gains a scrollbar', () => {
  const row = document.createElement('div')
  const el = document.createElement('span')
  const img = document.createElement('img')
  el.attachShadow({ mode: 'open' }).append(img)
  el.setAttribute('data-seq', '9s')
  Object.defineProperty(img, 'naturalWidth', { value: 75 })
  Object.defineProperty(img, 'naturalHeight', { value: 100 })
  let width = 420
  Object.defineProperty(row, 'clientWidth', { get: () => width })
  row.append(el)
  document.body.append(row)
  try {
    registerMahgen(el, 'coach-show', row)
    for (width of [405, 420, 405, 240, 600]) {
      applyMahgenSize(el)
      expect(el.style.height).toBe('48px')
      expect(el.style.width).toBe('36px')
      expect(img.style.height).toBe('48px')
    }
  } finally {
    unregisterMahgen(el)
    row.remove()
  }
})
