import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings'
import type { TeacherSettings } from '@/lib/teacherSettings'
import { useUpdaterStore } from '@/stores/updaterStore'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ HAS_TAURI: false, invoke }))
vi.mock('@/components/AccessoryTools', () => ({AccessoryHistory: () => <p>本地历史记录</p>,ToolSection: ({title,children}:{title:string;children:React.ReactNode}) => <section aria-label={title}>{children}</section>}))
vi.mock('@/routes/Logs', () => ({Logs: ({embedded}:{embedded:boolean}) => <p>只读日志内容 {String(embedded)}</p>}))
vi.mock('@/components/UpdateDialog', () => ({UpdateDialog: () => null}))
vi.mock('@/components/ui/sonner', () => ({Toaster: () => null}))
const timing = {
  majsoul: {pre_click_delay_min_ms:1000,pre_click_delay_max_ms:3000,inter_click_delay_ms:300,hover_delay_ms:200,click_hold_ms:100,verify_input_ms:300,click_retries:2,reload_after_failures:3,dealer_first_discard_extra_delay_ms:2000},
  delay: {mode:'lua' as const,min_delay_ms:1000,min_button_delay_ms:1600,distribution:'log_normal' as const,lognormal:{},bank_on_long_thought:true,riichi_extra_ms:0,kan_extra_ms:0,safety_margin_ms:1000,bank_use_fraction:0.25,bank_max_single_ms:5000,no_budget_cap_ms:15000},
}
beforeEach(() => {
  invoke.mockReset()
  window.history.replaceState(null,'','/')
  useUpdaterStore.setState({applying:false,dialogOpen:false,pendingUpdate:null,checking:false,checkedThisSession:false,lastError:null})
  const value:TeacherSettings = structuredClone({session:{room:'auto',mode:'south4'},timing,defaults:timing})
  invoke.mockImplementation((name:string,args?:{patch:Partial<TeacherSettings>}) => Promise.resolve(name === 'get_teacher_settings' ? value : name === 'save_teacher_settings' ? {...value,...args?.patch} : name === 'get_teacher_version' ? '3.7.2.15' : null))
})
async function mount() {
  render(<Settings />)
  await screen.findByRole('combobox',{name:'自动排队房间'})
}
describe('confirmed settings plus history and logs', () => {
  it('keeps all five confirmed pages and excludes unrelated pages', async () => {
    await mount()
    expect(screen.getAllByRole('tab').map(el => el.textContent)).toEqual(['自动打牌','界面','软件更新','历史记录','日志查看'])
    for(const name of ['总览','实时分析','机器人','网络','云端模型']) expect(screen.queryByRole('tab',{name})).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('set_autoplay_enabled',expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('sync_embedded_game',expect.anything())
  })
  it('provides a wide custom title-bar drag region and a separate close button', async () => {
    await mount()
    const titlebar=screen.getByRole('toolbar',{name:'窗口标题栏'})
    expect(titlebar.hasAttribute('data-tauri-drag-region')).toBe(true)
    const close=screen.getByRole('button',{name:'关闭窗口'})
    expect(titlebar.contains(close)).toBe(true)
    expect(close.hasAttribute('data-tauri-drag-region')).toBe(false)
  })
  it('saves only edited autoplay preferences and retains the default/custom parameters', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('操作参数'),{target:{value:'custom'}})
    fireEvent.change(screen.getByLabelText('延迟模式'),{target:{value:'legacy'}})
    fireEvent.change(screen.getByLabelText('随机等待下限（毫秒）'),{target:{value:'1200'}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_teacher_settings',{patch:{timing:{...timing,majsoul:{...timing.majsoul,pre_click_delay_min_ms:1200},delay:{...timing.delay,mode:'legacy'}}}}))
    expect(invoke).not.toHaveBeenCalledWith('update_config',expect.anything())
    fireEvent.change(screen.getByLabelText('操作参数'),{target:{value:'default'}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('save_teacher_settings',{patch:{timing}}))
  })
  it('preserves unsaved settings when closing with the title-bar button', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('自动排队赛制'),{target:{value:'east4'}})
    fireEvent.click(screen.getByRole('button',{name:'关闭窗口'}))
    expect(screen.getByText('自动打牌参数尚未保存')).toBeDefined()
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}))
    expect(screen.getByLabelText('自动排队赛制')).toHaveProperty('value','east4')
  })
  it('exposes appearance controls and update controls alongside the record tools', async () => {
    await mount()
    fireEvent.click(screen.getByRole('tab',{name:'界面'}))
    expect(screen.getByLabelText('语言')).toBeDefined()
    expect(screen.getByLabelText('显示模式')).toBeDefined()
    expect(screen.getByLabelText('界面缩放')).toBeDefined()
    fireEvent.click(screen.getByRole('tab',{name:'软件更新'}))
    expect(await screen.findByText('3.7.2.15')).toBeDefined()
    expect(screen.getByRole('switch',{name:'自动检查更新'})).toBeDefined()
    expect(screen.getByRole('button',{name:'检查更新'})).toBeDefined()
    fireEvent.click(screen.getByRole('tab',{name:'历史记录'}))
    expect(screen.getByText('本地历史记录')).toBeDefined()
    fireEvent.click(screen.getByRole('tab',{name:'日志查看'}))
    expect(screen.getByText('只读日志内容 true')).toBeDefined()
  })
  it('supports direct navigation to logs without restoring removed pages', async () => {
    window.history.replaceState(null,'','/?settingsTab=logs')
    render(<Settings />)
    expect(await screen.findByText('只读日志内容 true')).toBeDefined()
    fireEvent(window,new CustomEvent('show-settings-tab',{detail:'overview'}))
    expect(screen.getByRole('tab',{name:'日志查看'}).getAttribute('aria-selected')).toBe('true')
    fireEvent(window,new CustomEvent('show-settings-tab',{detail:'autoplay'}))
    expect(await screen.findByRole('combobox',{name:'自动排队房间'})).toBeDefined()
  })
})
