import { beforeEach, describe, expect, it, vi } from 'vitest'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke }))
import { useUpdaterStore } from './updaterStore'

describe('teacher release checks', () => {
  beforeEach(() => {
    invoke.mockReset()
    useUpdaterStore.setState({ checkedThisSession: false, checking: false, lastError: null,
      pendingUpdate: null, lastChecked: Date.now(), applying: false })
  })
  it('checks on a fresh launch even if the previous launch checked recently', async () => {
    invoke.mockResolvedValue(null)
    await useUpdaterStore.getState().checkNow()
    expect(invoke).toHaveBeenCalledOnce()
    await useUpdaterStore.getState().checkNow()
    expect(invoke).toHaveBeenCalledOnce()
    await useUpdaterStore.getState().checkNow(true)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('reports network failure without treating it as already up to date', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      invoke.mockRejectedValueOnce('connection failed')
      await useUpdaterStore.getState().checkNow(true)
      expect(useUpdaterStore.getState().lastError).toBe('connection failed')
      expect(useUpdaterStore.getState().checkedThisSession).toBe(false)
      invoke.mockResolvedValueOnce(null)
      await useUpdaterStore.getState().checkNow()
      expect(useUpdaterStore.getState().lastError).toBeNull()
    } finally { warn.mockRestore() }
  })
})
