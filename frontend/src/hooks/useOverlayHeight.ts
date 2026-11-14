import { useEffect, type RefObject } from 'react'
import { invoke } from '@/lib/tauri'

// Measure natural content, never the viewport. Fixed tile sizes and a body
// without scrollbars make height changes independent of the window height.
export function useOverlayHeight(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const content = ref.current
    if (!content) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastHeight = 0
    let pending: number | undefined
    let running = false

    const flush = async () => {
      if (running || cancelled) return
      running = true
      while (!cancelled && pending !== undefined) {
        const height = pending
        pending = undefined
        try { await invoke('fit_overlay_height', { height }) }
        catch { /* unavailable in browser previews or during window shutdown */ }
      }
      running = false
    }
    const measure = () => {
      if (cancelled) return
      // One logical pixel covers fractional font/layout rounding at high DPI.
      const height = Math.ceil(content.getBoundingClientRect().height) + 1
      if (height <= 1 || height === lastHeight) return
      lastHeight = height
      pending = height
      clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, 80)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    measure()
    void document.fonts?.ready.then(measure)
    return () => {
      cancelled = true
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [ref])
}
