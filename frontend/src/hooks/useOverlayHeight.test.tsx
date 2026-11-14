import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverlayHeight } from './useOverlayHeight'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke }))

describe('overlay natural content sizing', () => {
  let resized: () => void
  let height: number
  let content: HTMLDivElement
  const disconnect = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset().mockResolvedValue(undefined)
    disconnect.mockReset()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect = disconnect
    })
    content = document.createElement('div')
    height = 228.2
    vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('fits growing and shrinking content, ignoring unchanged resize notifications', async () => {
    renderHook(() => useOverlayHeight({ current: content }))
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(invoke).toHaveBeenLastCalledWith('fit_overlay_height', { height: 230 })
    act(() => { resized(); resized() })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(invoke).toHaveBeenCalledTimes(1)
    height = 350
    act(() => resized())
    height = 370
    act(() => resized())
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('fit_overlay_height', { height: 371 })
    height = 120
    act(() => resized())
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(invoke).toHaveBeenLastCalledWith('fit_overlay_height', { height: 121 })
  })

  it('serializes native requests and cancels pending work on unmount', async () => {
    let resolve!: () => void
    invoke.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const { unmount } = renderHook(() => useOverlayHeight({ current: content }))
    await act(() => vi.advanceTimersByTimeAsync(80))
    height = 400
    act(() => resized())
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(); await Promise.resolve() })
    expect(invoke).toHaveBeenLastCalledWith('fit_overlay_height', { height: 401 })
    height = 500
    act(() => resized())
    unmount()
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
