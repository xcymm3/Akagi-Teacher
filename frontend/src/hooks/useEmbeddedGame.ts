import { useEffect, useState, type RefObject } from 'react'
import { HAS_TAURI, invoke } from '@/lib/tauri'

type Bounds = { x: number; y: number; width: number; height: number; visible: boolean }
let nativeQueue: Promise<unknown> = Promise.resolve()
function sync(bounds: Bounds) {
  const request = nativeQueue.then(() => invoke('sync_embedded_game', { bounds }))
  nativeQueue = request.catch(() => {})
  return request
}

// Native child webviews are above HTML. Hide the game for modal dialogs and
// when leaving this route, while keeping the logged-in page alive.
export function useEmbeddedGame(ref: RefObject<HTMLDivElement | null>) {
  const [error, setError] = useState('')
  useEffect(() => {
    const element = ref.current
    if (!element || !HAS_TAURI) return
    let active = true
    let pending: Bounds | null = null
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous = ''
    const flush = async () => {
      if (running) return
      running = true
      while (active && pending) {
        const bounds = pending
        pending = null
        try {
          await sync(bounds)
          if (active) setError('')
        } catch (e) { if (active) setError(String(e)) }
      }
      running = false
    }
    const measure = () => {
      if (!active) return
      const rect = element.getBoundingClientRect()
      const bounds = {
        x: Math.max(0, rect.x), y: Math.max(0, rect.y),
        width: Math.max(1, rect.width), height: Math.max(1, rect.height),
        visible: rect.width > 0 && rect.height > 0 && !document.querySelector('[role="dialog"], [role="alertdialog"]'),
      }
      const key = JSON.stringify(bounds)
      if (key === previous) return
      previous = key
      pending = bounds
      clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, 50)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const modals = new MutationObserver(measure)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'data-state'] })
    window.addEventListener('resize', measure)
    measure()
    return () => {
      active = false
      clearTimeout(timer)
      observer.disconnect()
      modals.disconnect()
      window.removeEventListener('resize', measure)
      // Serialize hide after any in-flight create/resize, including StrictMode
      // cleanup. A later mount will enqueue its visible bounds afterwards.
      pending = null
      void sync({ x: 0, y: 0, width: 1, height: 1, visible: false }).catch(() => {})
    }
  }, [ref])
  return error
}
