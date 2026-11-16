import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings'
import { useUpdaterStore, type UpdateInfo } from '@/stores/updaterStore'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ HAS_TAURI: false, invoke }))
vi.mock('@/components/AccessoryTools', () => ({AccessoryHistory: () => <p>本地历史记录</p>}))
vi.mock('@/routes/Logs', () => ({Logs: ({embedded}:{embedded:boolean}) => <p>只读日志内容 {String(embedded)}</p>}))
vi.mock('@/components/UpdateDialog', () => ({UpdateDialog: () => useUpdaterStore(s => s.dialogOpen) ? <p>临时更新提示</p> : null}))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))

describe('history and log accessory window', () => {
  beforeEach(() => {
    invoke.mockReset()
    window.history.replaceState(null,'','/')
    useUpdaterStore.setState({applying:false,dialogOpen:false,pendingUpdate:null,checkNow:vi.fn().mockResolvedValue(undefined)})
  })
  it('only exposes history and logs, without settings reads or writes', () => {
    render(<Settings />)
    expect(screen.getAllByRole('tab').map(el => el.textContent)).toEqual(['历史记录','日志查看'])
    expect(screen.getByText('本地历史记录')).toBeDefined()
    expect(screen.queryByRole('button',{name:'保存'})).toBeNull()
    expect(screen.queryByRole('switch',{name:'自动打牌'})).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('switches to the embedded log viewer without hiding or reconnecting the game', () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('tab',{name:'日志查看'}))
    expect(screen.getByText('只读日志内容 true')).toBeDefined()
    expect(screen.queryByText('本地历史记录')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('supports a logs deep link and ignores removed or invalid page requests', () => {
    window.history.replaceState(null,'','/?settingsTab=logs')
    render(<Settings />)
    expect(screen.getByRole('tab',{name:'日志查看'}).getAttribute('aria-selected')).toBe('true')
    fireEvent(window,new CustomEvent('show-settings-tab',{detail:'autoplay'}))
    expect(screen.getByRole('tab',{name:'日志查看'}).getAttribute('aria-selected')).toBe('true')
    fireEvent(window,new CustomEvent('show-settings-tab',{detail:'history'}))
    expect(screen.getByText('本地历史记录')).toBeDefined()
  })
  it('falls back to history for a removed page URL', () => {
    window.history.replaceState(null,'','/?settingsTab=updates')
    render(<Settings />)
    expect(screen.getByText('本地历史记录')).toBeDefined()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })
  it('retains transient update notifications without restoring an update page', async () => {
    useUpdaterStore.setState({pendingUpdate:{latest_tag:'teacher-v3.7.2.16'} as UpdateInfo})
    render(<Settings />)
    fireEvent(window,new Event('show-update-dialog'))
    await waitFor(() => expect(screen.getByText('临时更新提示')).toBeDefined())
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByText('本地历史记录')).toBeDefined()
  })
})
