import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEmbeddedGame } from './useEmbeddedGame'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ HAS_TAURI: true, invoke }))
describe('native game layout lifecycle', () => {
  let resized: () => void
  let height: number
  let content: HTMLDivElement
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    content = document.createElement('div')
    height = 700
    vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => ({x:0,y:48,width:1100,height}) as DOMRect)
  })
  afterEach(async () => { await act(() => vi.runOnlyPendingTimersAsync()); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('fits the native view, deduplicates equal bounds and hides on navigation', async () => {
    const { unmount } = renderHook(() => useEmbeddedGame({ current: content }))
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(invoke).toHaveBeenLastCalledWith('sync_embedded_game', {bounds:{x:0,y:48,width:1100,height:700,visible:true}})
    act(() => {resized();resized()})
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(invoke).toHaveBeenCalledTimes(1)
    height = 800
    act(() => resized())
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(invoke).toHaveBeenLastCalledWith('sync_embedded_game', {bounds:{x:0,y:48,width:1100,height:800,visible:true}})
    unmount()
    await act(async () => { await Promise.resolve() })
    expect(invoke).toHaveBeenLastCalledWith('sync_embedded_game', {bounds:expect.objectContaining({visible:false})})
  })
  it('hides for modal dialogs and restores the logged-in view after closing', async () => {
    renderHook(() => useEmbeddedGame({ current: content }))
    await act(() => vi.advanceTimersByTimeAsync(50))
    const dialog = document.createElement('div')
    dialog.setAttribute('role','dialog')
    await act(async () => { document.body.append(dialog); await Promise.resolve() })
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(invoke).toHaveBeenLastCalledWith('sync_embedded_game', {bounds:expect.objectContaining({visible:false})})
    await act(async () => { dialog.remove(); await Promise.resolve() })
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(invoke).toHaveBeenLastCalledWith('sync_embedded_game', {bounds:expect.objectContaining({visible:true})})
  })
  it('serializes cleanup before a remount even while native creation is pending', async () => {
    let resolve!: () => void
    invoke.mockImplementationOnce(() => new Promise<void>(done => {resolve=done}))
    const first = renderHook(() => useEmbeddedGame({current:content}))
    await act(() => vi.advanceTimersByTimeAsync(50))
    first.unmount()
    const second = renderHook(() => useEmbeddedGame({current:content}))
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(); await Promise.resolve() })
    expect(invoke.mock.calls.map(c => c[1].bounds.visible)).toEqual([true,false,true])
    second.unmount()
    await act(async () => { await Promise.resolve() })
  })
})
