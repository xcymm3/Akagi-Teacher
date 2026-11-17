import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks'
import { emit, TauriEvent } from '@tauri-apps/api/event'
import capability from '../../../capabilities/settings.json'
import { Settings } from './Settings'
import { useUpdaterStore } from '@/stores/updaterStore'
import type { TeacherSettings } from '@/lib/teacherSettings'

// Keep the installed Tauri window/event implementations; mock only their IPC transport.
vi.mock('@/lib/tauri', async () => ({HAS_TAURI:true,invoke:(await import('@tauri-apps/api/core')).invoke}))
vi.mock('@/hooks/useTauriBridge', () => ({useTauriBridge: () => {}}))
vi.mock('@/hooks/useUiPreferences', () => ({useUiPreferences: () => {}}))
vi.mock('@/components/AccessoryTools', () => ({AccessoryHistory: () => null,ToolSection: ({children}:{children:React.ReactNode}) => <section>{children}</section>}))
vi.mock('@/routes/Logs', () => ({Logs: () => null}))
vi.mock('@/components/UpdateDialog', () => ({UpdateDialog: () => null}))
vi.mock('@/components/ui/sonner', () => ({Toaster: () => null}))
const timing = {
  majsoul:{pre_click_delay_min_ms:1000,pre_click_delay_max_ms:3000,inter_click_delay_ms:300,hover_delay_ms:200,click_hold_ms:100,verify_input_ms:300,click_retries:2,reload_after_failures:3,dealer_first_discard_extra_delay_ms:2000},
  delay:{mode:'lua' as const,min_delay_ms:1000,min_button_delay_ms:1600,distribution:'log_normal' as const,lognormal:{},bank_on_long_thought:true,riichi_extra_ms:0,kan_extra_ms:0,safety_margin_ms:1000,bank_use_fraction:0.25,bank_max_single_ms:5000,no_budget_cap_ms:15000},
}
let value:TeacherSettings
let destroyed:string[]
let calls:string[]
beforeEach(() => {
  value=structuredClone({session:{room:'auto',mode:'south4'},timing,defaults:timing})
  destroyed=[];calls=[]
  window.history.replaceState(null,'','/')
  useUpdaterStore.setState({applying:false,dialogOpen:false,pendingUpdate:null})
  mockWindows('settings')
  mockIPC(async (command,args) => {
    calls.push(command)
    const payload = args && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array) ? args : undefined
    if(command === 'get_teacher_settings') return value
    if(command === 'save_teacher_settings') {
      value={...value,...payload?.patch as Partial<TeacherSettings>}
      return value
    }
    if(command === 'plugin:window|close') {
      if(!capability.permissions.includes('core:window:allow-close')) throw new Error('close denied')
      await emit(TauriEvent.WINDOW_CLOSE_REQUESTED)
    }
    if(command === 'plugin:window|destroy') {
      if(!capability.permissions.includes('core:window:allow-destroy')) throw new Error('destroy denied')
      destroyed.push(String(payload?.label))
    }
    return null
  },{shouldMockEvents:true})
})
afterEach(async () => {cleanup();await Promise.resolve();clearMocks()})
async function mount() {
  render(<Settings />)
  await screen.findByRole('combobox',{name:'自动排队赛制'})
}
describe('settings native close lifecycle', () => {
  it('grants both close-request and final destruction to the settings webview', () => {
    expect(capability.webviews).toEqual(['settings'])
    expect(capability.permissions).toEqual(expect.arrayContaining(['core:window:allow-close','core:window:allow-destroy']))
  })
  it('closes from the title-bar button through the real SDK close-to-destroy sequence', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button',{name:'关闭窗口'}))
    await waitFor(() => expect(destroyed).toEqual(['settings']))
    expect(calls).toContain('plugin:window|close')
    expect(calls).toContain('plugin:window|destroy')
    expect(calls).not.toContain('set_autoplay_enabled')
  })
  it('completes an ordinary operating-system close request', async () => {
    await mount()
    await act(async () => {await emit(TauriEvent.WINDOW_CLOSE_REQUESTED)})
    await waitFor(() => expect(destroyed).toEqual(['settings']))
  })
  it('blocks dirty native close requests, then closes after discarding edits', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('自动排队赛制'),{target:{value:'east4'}})
    await act(async () => {await emit(TauriEvent.WINDOW_CLOSE_REQUESTED)})
    expect(destroyed).toEqual([])
    expect(screen.getByText('自动打牌参数尚未保存')).toBeDefined()
    fireEvent.click(screen.getByRole('button',{name:'放弃并关闭'}))
    await waitFor(() => expect(destroyed).toEqual(['settings']))
  })
  it('closes normally after saving edits', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('自动排队赛制'),{target:{value:'east4'}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await screen.findByText('设置已保存')
    fireEvent.click(screen.getByRole('button',{name:'关闭窗口'}))
    await waitFor(() => expect(destroyed).toEqual(['settings']))
  })
  it('retains the update-in-progress guard and permits close when the update finishes', async () => {
    await mount()
    await act(async () => {useUpdaterStore.setState({applying:true})})
    await act(async () => {await emit(TauriEvent.WINDOW_CLOSE_REQUESTED)})
    expect(destroyed).toEqual([])
    expect(screen.getByText('更新进行中，请先取消下载或等待完成。')).toBeDefined()
    await act(async () => {useUpdaterStore.setState({applying:false})})
    fireEvent.click(screen.getByRole('button',{name:'关闭窗口'}))
    await waitFor(() => expect(destroyed).toEqual(['settings']))
  })
})
