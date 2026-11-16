import { beforeEach, describe, expect, it, vi } from 'vitest'
const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke, listen }))
import { useUpdaterStore, type UpdateInfo, type UpdateProgress } from './updaterStore'

describe('teacher release checks', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset().mockResolvedValue(vi.fn())
    useUpdaterStore.setState({ checkedThisSession: false, checking: false, lastError: null,
      pendingUpdate: null, lastChecked: Date.now(), applying: false, progress:null, applyStartedAt:null, progressAt:null })
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

describe('update application progress and cancellation', () => {
  const info={latest_tag:'teacher-v3.7.2.15',asset_size:100} as UpdateInfo
  beforeEach(() => {
    invoke.mockReset(); listen.mockReset().mockResolvedValue(vi.fn())
    useUpdaterStore.setState({pendingUpdate:info,applying:false,progress:null,lastError:null})
  })
  it('subscribes before download, receives byte progress and clears busy state on return', async () => {
    let callback: (p:UpdateProgress)=>void = () => {}
    let finish: ()=>void = () => {}
    const unlisten=vi.fn()
    listen.mockImplementation(async (_name,cb) => { callback=cb;return unlisten })
    invoke.mockImplementation(() => new Promise<void>(resolve => {finish=resolve}))
    const operation=useUpdaterStore.getState().applyUpdate()
    await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('apply_update'))
    callback({stage:'downloading',downloaded:50,total:100})
    expect(useUpdaterStore.getState().progress?.downloaded).toBe(50)
    expect(useUpdaterStore.getState().applying).toBe(true)
    finish();await operation
    expect(useUpdaterStore.getState().applying).toBe(false)
    expect(unlisten).toHaveBeenCalledOnce()
  })
  it('cancels the backend operation rather than pretending a pending invoke is finished', async () => {
    let rejectApply: (e:unknown)=>void = () => {}
    invoke.mockImplementation((cmd:string)=>cmd==='cancel_update' ? Promise.resolve(true) : new Promise((_resolve,reject)=>{rejectApply=reject}))
    const operation=useUpdaterStore.getState().applyUpdate()
    await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('apply_update'))
    await useUpdaterStore.getState().cancelUpdate()
    expect(useUpdaterStore.getState().applying).toBe(true)
    expect(useUpdaterStore.getState().progress?.stage).toBe('cancelling')
    rejectApply({kind:'cancelled'})
    expect(await operation).toEqual({kind:'cancelled'})
    expect(useUpdaterStore.getState().applying).toBe(false)
    expect(useUpdaterStore.getState().lastError).toBeNull()
  })
  it('does not overwrite an already completed cancellation with a late cancel reply', async () => {
    let rejectApply: (e:unknown)=>void = () => {}
    let acceptCancel: (v:boolean)=>void = () => {}
    invoke.mockImplementation((cmd:string)=>cmd==='cancel_update' ? new Promise<boolean>(resolve=>{acceptCancel=resolve}) : new Promise((_resolve,reject)=>{rejectApply=reject}))
    const operation=useUpdaterStore.getState().applyUpdate()
    await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('apply_update'))
    const cancellation=useUpdaterStore.getState().cancelUpdate()
    rejectApply({kind:'cancelled'});await operation
    acceptCancel(true);await cancellation
    expect(useUpdaterStore.getState().applying).toBe(false)
    expect(useUpdaterStore.getState().progress?.stage).toBe('cancelled')
  })
  it('releases UI state and listener on network failure and allows retry', async () => {
    const unlisten=vi.fn();listen.mockResolvedValue(unlisten)
    invoke.mockRejectedValueOnce({kind:'other',message:'等待下载服务器响应超时'})
    await useUpdaterStore.getState().applyUpdate()
    expect(useUpdaterStore.getState().applying).toBe(false)
    expect(useUpdaterStore.getState().lastError).toContain('响应超时')
    expect(unlisten).toHaveBeenCalledOnce()
    invoke.mockResolvedValueOnce(undefined)
    await useUpdaterStore.getState().applyUpdate()
    expect(useUpdaterStore.getState().lastError).toBeNull()
  })
})
