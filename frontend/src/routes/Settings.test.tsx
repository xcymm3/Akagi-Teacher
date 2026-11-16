import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings'
import type { TeacherSettings } from '@/lib/teacherSettings'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ HAS_TAURI: false, invoke }))
vi.mock('@/components/UpdateDialog', () => ({ UpdateDialog: () => null }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
const timing = {
  majsoul: { pre_click_delay_min_ms:1000,pre_click_delay_max_ms:3000,inter_click_delay_ms:300,hover_delay_ms:200,click_hold_ms:100,verify_input_ms:300,click_retries:2,reload_after_failures:3,dealer_first_discard_extra_delay_ms:2000 },
  delay: {mode:'lua' as const,min_delay_ms:1000,min_button_delay_ms:1600,distribution:'log_normal' as const,lognormal:{},bank_on_long_thought:true,riichi_extra_ms:0,kan_extra_ms:0,safety_margin_ms:1000,bank_use_fraction:0.25,bank_max_single_ms:5000,no_budget_cap_ms:15000},
}
async function mount() {
  const value: TeacherSettings = structuredClone({ session:{room:'auto',mode:'south4'}, timing, defaults:timing })
  invoke.mockImplementation((name: string, args?: {patch:Partial<TeacherSettings>}) => Promise.resolve(name === 'get_teacher_settings' ? value : name === 'save_teacher_settings' ? {...value,...args?.patch} : undefined))
  render(<Settings />)
  await screen.findByRole('combobox', {name:'自动排队房间'})
}
describe('compact accessory settings', () => {
  beforeEach(() => { invoke.mockReset() })
  it('exposes the compact tools and preferences sidebar without hiding the game or changing the master switch', async () => {
    await mount()
    expect(screen.getAllByRole('tab').map(el => el.textContent)).toEqual(['总览','实时分析','历史记录','自动打牌','界面','软件更新'])
    for (const label of ['平台','云端模型','悬浮窗','日志','网络','本地模型']) expect(screen.queryByText(label)).toBeNull()
    expect(screen.queryByRole('switch', {name:'自动打牌'})).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('sync_embedded_game', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('set_autoplay_enabled', expect.anything())
  })
  it('saves only changed preferences without posting the full config', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('自动排队赛制'), {target:{value:'east4'}})
    fireEvent.click(screen.getByRole('button', {name:'保存'}))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_teacher_settings', {patch:{session:{room:'auto',mode:'east4'}}}))
    expect(invoke).not.toHaveBeenCalledWith('update_config', expect.anything())
    expect(await screen.findByRole('status')).toHaveProperty('textContent','设置已保存')
  })
  it('exposes custom legacy delays and restores canonical defaults', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('操作参数'), {target:{value:'custom'}})
    fireEvent.change(screen.getByLabelText('延迟模式'), {target:{value:'legacy'}})
    fireEvent.change(screen.getByLabelText('随机等待下限（毫秒）'), {target:{value:'1200'}})
    fireEvent.click(screen.getByRole('button', {name:'保存'}))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_teacher_settings', {patch:{timing:{...timing,majsoul:{...timing.majsoul,pre_click_delay_min_ms:1200},delay:{...timing.delay,mode:'legacy'}}}}))
    fireEvent.change(screen.getByLabelText('操作参数'), {target:{value:'default'}})
    fireEvent.click(screen.getByRole('button', {name:'保存'}))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('save_teacher_settings', {patch:{timing}}))
  })
  it('keeps unsaved edits when closing and surfaces save failures', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('自动排队赛制'), {target:{value:'east4'}})
    fireEvent.click(screen.getByRole('button', {name:'关闭'}))
    expect(screen.getByText('自动打牌参数尚未保存')).toBeDefined()
    fireEvent.click(screen.getByRole('button', {name:'继续编辑'}))
    invoke.mockRejectedValueOnce(new Error('磁盘写入失败'))
    fireEvent.click(screen.getByRole('button', {name:'保存'}))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Error: 磁盘写入失败')
    expect(screen.getByLabelText('自动排队赛制')).toHaveProperty('value','east4')
  })
  it('applies cross-window scale changes without reloading', async () => {
    await mount()
    fireEvent(window, new StorageEvent('storage',{key:'akagi.ui.scale',newValue:'1.25'}))
    expect(document.documentElement.style.fontSize).toBe('20px')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
