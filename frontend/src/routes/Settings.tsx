/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
// Custom-drawn window chrome, existing theme and five confirmed tool/settings pages.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { History, ScrollText, Gamepad2, Palette, Download, ChevronRight, X, PanelsTopLeft } from 'lucide-react'
import { useTauriBridge } from '@/hooks/useTauriBridge'
import { AccessoryHistory, ToolSection } from '@/components/AccessoryTools'
import { Logs } from '@/routes/Logs'
import { openExternal } from '@/lib/external'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Toaster } from '@/components/ui/sonner'
import { UpdateDialog } from '@/components/UpdateDialog'
import { HAS_TAURI, invoke } from '@/lib/tauri'
import { settingsPatch, sameSettings, type TeacherSettings } from '@/lib/teacherSettings'
import { useUiPreferences } from '@/hooks/useUiPreferences'
import { useThemeStore, type ThemeMode } from '@/stores/themeStore'
import { SCALE_MIN, SCALE_MAX, SCALE_STEP, useUiPrefsStore } from '@/stores/uiPrefsStore'
import { useUpdaterStore } from '@/stores/updaterStore'
import { LANG_LABELS, SUPPORTED_LANGS } from '@/i18n'
import type { AutoplaySessionConfig } from '@/types'

const NAV = [
  {id:'autoplay',label:'自动打牌',description:'排队偏好与操作节奏',icon:Gamepad2},
  {id:'appearance',label:'界面',description:'语言与显示偏好',icon:Palette},
  {id:'updates',label:'软件更新',description:'检查并安装最新版本',icon:Download},
  {id:'history',label:'历史记录',description:'对局统计、结算与牌谱',icon:History},
  {id:'logs',label:'日志查看',description:'运行日志与事件检查',icon:ScrollText},
] as const
type Tab = typeof NAV[number]['id']
function validTab(value:unknown): value is Tab { return NAV.some(item => item.id === value) }
const selectClass = 'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm shadow-xs transition-colors hover:border-ring/50 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring/30 disabled:opacity-50'
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid grid-cols-[minmax(0,1fr)_minmax(110px,180px)] items-center gap-4 text-sm"><span>{label}</span>{children}</label>
}

export function Settings() {
  useUiPreferences()
  useTauriBridge()
  const [tab, setTab] = useState<Tab>(() => { const value = new URLSearchParams(window.location.search).get('settingsTab'); return validTab(value) ? value : 'autoplay' })
  const current = NAV.find(item => item.id === tab)!
  const [initial, setInitial] = useState<TeacherSettings | null>(null)
  const [draft, setDraft] = useState<TeacherSettings | null>(null)
  const [custom, setCustom] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [closePrompt, setClosePrompt] = useState(false)
  const applying = useUpdaterStore(s => s.applying)
  const allowClose = useRef(false)
  const [reload, setReload] = useState(0)
  const dirty = !!draft && !!initial && Object.keys(settingsPatch(initial, draft)).length > 0
  useEffect(() => {
    let active = true
    void invoke<TeacherSettings>('get_teacher_settings').then(value => {
      if (!active) return
      setError(''); setInitial(value); setDraft(value)
      setCustom(!sameSettings(value.timing, value.defaults))
    }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [reload])
  useEffect(() => {
    const show = (event: Event) => { const value = (event as CustomEvent<unknown>).detail; if (validTab(value)) setTab(value) }
    window.addEventListener('show-settings-tab', show)
    return () => window.removeEventListener('show-settings-tab', show)
  }, [])
  useEffect(() => {
    if (!HAS_TAURI) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onCloseRequested(event => {
      if (allowClose.current) return
      if (applying || saving || dirty) {
        event.preventDefault()
        if (applying || saving) setNotice(applying ? '更新进行中，请先取消下载或等待完成。' : '正在保存，请稍候。')
        else setClosePrompt(true)
      }
    }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(e => setError(String(e)))
    return () => { disposed = true; unlisten?.() }
  }, [dirty, saving, applying])
  const close = async (discard = false) => {
    if (applying || saving) return
    if (dirty && !discard) { setClosePrompt(true); return }
    allowClose.current = true
    if (HAS_TAURI) {
      try { await getCurrentWindow().close() }
      catch (e) { allowClose.current = false; setError(String(e)) }
    }
  }
  const save = async () => {
    if (!draft || !initial) return
    setSaving(true); setError(''); setNotice('')
    try {
      const value = await invoke<TeacherSettings>('save_teacher_settings', { patch: settingsPatch(initial, draft) })
      setInitial(value); setDraft(value); setNotice('设置已保存'); setClosePrompt(false)
    } catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }
  return <main aria-label="设置与记录" className="flex h-screen min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background text-foreground">
    <header role="toolbar" aria-label="窗口标题栏" data-tauri-drag-region className="flex h-11 shrink-0 select-none items-center gap-2 border-b border-border/60 bg-background px-3 cursor-grab active:cursor-grabbing">
      <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary"><PanelsTopLeft className="size-3.5" strokeWidth={1.7} /></span>
        <span className="text-xs font-medium">Akagi <span className="font-normal text-muted-foreground">教师版</span></span>
        <span className="mx-1 h-3 w-px bg-border" />
        <span className="text-xs text-muted-foreground">设置与记录</span>
      </div>
      <button type="button" aria-label="关闭窗口" title="关闭" disabled={saving || applying} onClick={() => void close()}
        className="flex h-7 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:bg-destructive/20 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-40"><X className="size-4" strokeWidth={1.6} /></button>
    </header>
    <div className="flex min-h-0 flex-1">
    <nav aria-label="设置分类" className="flex w-40 shrink-0 flex-col border-r border-border/70 bg-muted/25 px-3 py-5" role="tablist" aria-orientation="vertical">
      <div className="mb-3 px-3 text-[11px] font-medium text-muted-foreground">偏好设置</div>
      {NAV.map(({id,label,icon:Icon},index) => <div key={id} className={index === 3 ? 'mt-6 border-t border-border/60 pt-4' : ''}>
        <button id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => setTab(id)}
          className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring active:bg-muted ${tab === id ? 'bg-background font-medium text-foreground shadow-xs ring-1 ring-border/70' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}>
          <Icon className="size-4 shrink-0" strokeWidth={1.7} />{label}{tab === id && <ChevronRight className="ml-auto size-3 text-muted-foreground" />}
        </button>
      </div>)}
    </nav>
    <div className="flex min-w-0 flex-1 flex-col">
    <header className="shrink-0 border-b border-border/60 px-6 py-5"><h1 className="text-lg font-semibold tracking-tight">{current.label}</h1><p className="mt-1 text-xs text-muted-foreground">{current.description}</p></header>
    <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className={`min-h-0 flex-1 bg-muted/10 ${tab === 'logs' ? 'flex flex-col overflow-hidden p-4' : 'overflow-y-auto p-6'}`}>
      {tab === 'history' && <AccessoryHistory />}
      {tab === 'logs' && <Logs embedded />}
      {tab === 'autoplay' && (draft ? <ToolSection title="排队与操作"><fieldset disabled={saving} className="grid gap-4 disabled:opacity-60">
        <Field label="自动排队房间"><select aria-label="自动排队房间" className={selectClass} value={draft.session.room}
          onChange={e => setDraft({ ...draft, session: { ...draft.session, room: e.target.value as AutoplaySessionConfig['room'] } })}>
          {([['auto','自动选择'],['bronze','铜之间'],['silver','银之间'],['gold','金之间'],['jade','玉之间'],['throne','王座之间']] as const).map(([v,label]) => <option value={v} key={v}>{label}</option>)}
        </select></Field>
        <Field label="自动排队赛制"><select aria-label="自动排队赛制" className={selectClass} value={draft.session.mode}
          onChange={e => setDraft({ ...draft, session: { ...draft.session, mode: e.target.value as AutoplaySessionConfig['mode'] } })}>
          <option value="east4">四麻东风</option><option value="south4">四麻半庄</option>
        </select></Field>
        <p className="text-xs text-muted-foreground">房间与赛制用于后续排队，已开始的匹配不变。自动打牌开关位于主窗口顶栏。</p>
        <Field label="操作参数"><select aria-label="操作参数" className={selectClass} value={custom ? 'custom' : 'default'} onChange={e => {
          const enabled = e.target.value === 'custom'; setCustom(enabled)
          if (!enabled) setDraft({ ...draft, timing: structuredClone(draft.defaults) })
        }}><option value="default">默认</option><option value="custom">自定义</option></select></Field>
        {custom ? <TimingFields draft={draft} setDraft={setDraft} /> : <p className="text-xs text-muted-foreground">使用默认延迟、点击校验、重试及失败恢复参数。</p>}
      </fieldset></ToolSection> : <div className="grid gap-3 text-sm text-muted-foreground">{error ? <Button variant="outline" onClick={() => setReload(value => value + 1)}>重新读取设置</Button> : '正在读取设置…'}</div>)}
      {tab === 'appearance' && <ToolSection title="显示偏好"><Appearance /></ToolSection>}
      {tab === 'updates' && <ToolSection title="版本与更新"><Updates /></ToolSection>}
    </section>
    {(tab === 'autoplay' || dirty || error || notice || closePrompt) && <footer className="grid shrink-0 gap-2 border-t border-border px-4 py-3">
      {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {closePrompt ? <div className="flex flex-wrap items-center gap-2 text-xs"><span className="mr-auto">自动打牌参数尚未保存</span>
        <Button size="sm" variant="outline" onClick={() => setClosePrompt(false)}>继续编辑</Button>
        <Button size="sm" variant="outline" onClick={() => void close(true)}>放弃并关闭</Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>保存</Button>
      </div> : <div className="flex items-center justify-end gap-2">
        {dirty && <span className="mr-auto text-xs text-muted-foreground">有未保存的修改</span>}
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</Button>
      </div>}
    </footer>}
    </div>
    </div>
    <Toaster /><UpdateDialog />
  </main>
}

function TimingFields({ draft, setDraft }: { draft: TeacherSettings; setDraft: (value: TeacherSettings) => void }) {
  const { timing } = draft
  const m = timing.majsoul
  const d = timing.delay
  const numberField = (label: string, section: 'majsoul' | 'delay', name: string, value: number, max = 60000) =>
    <Field key={name} label={label}><Input aria-label={label} type="number" min={0} max={max} step={1} value={value}
      onChange={e => setDraft({ ...draft, timing: { ...timing, [section]: { ...timing[section], [name]: Math.min(max, Math.max(0, Math.floor(Number(e.target.value) || 0))) } } })} /></Field>
  return <div className="grid gap-3 border-t border-border pt-4">
    <Field label="延迟模式"><select aria-label="延迟模式" className={selectClass} value={d.mode}
      onChange={e => setDraft({ ...draft, timing: { ...timing, delay: { ...d, mode: e.target.value as 'lua' | 'legacy' } } })}>
      <option value="lua">Lua 拟人延迟</option><option value="legacy">随机区间延迟</option>
    </select></Field>
    {d.mode === 'legacy' && <>
      {numberField('随机等待下限（毫秒）', 'majsoul', 'pre_click_delay_min_ms', m.pre_click_delay_min_ms)}
      {numberField('随机等待上限（毫秒）', 'majsoul', 'pre_click_delay_max_ms', m.pre_click_delay_max_ms)}
    </>}
    {numberField('最短思考时间（毫秒）', 'delay', 'min_delay_ms', d.min_delay_ms)}
    {numberField('动作按钮最短等待（毫秒）', 'delay', 'min_button_delay_ms', d.min_button_delay_ms)}
    {numberField('连续点击间隔（毫秒）', 'majsoul', 'inter_click_delay_ms', m.inter_click_delay_ms)}
    {numberField('悬停等待（毫秒）', 'majsoul', 'hover_delay_ms', m.hover_delay_ms)}
    {numberField('点击按住时间（毫秒）', 'majsoul', 'click_hold_ms', m.click_hold_ms)}
    {numberField('输入校验等待（毫秒）', 'majsoul', 'verify_input_ms', m.verify_input_ms)}
    {numberField('点击重试次数', 'majsoul', 'click_retries', m.click_retries, 10)}
    {numberField('连续失败后刷新次数阈值', 'majsoul', 'reload_after_failures', m.reload_after_failures, 20)}
    {numberField('庄家首打额外等待（毫秒）', 'majsoul', 'dealer_first_discard_extra_delay_ms', m.dealer_first_discard_extra_delay_ms)}
    <p className="text-xs text-muted-foreground">校验等待、重试或失败恢复填 0 可关闭对应机制。参数过低可能导致点击失效。</p>
  </div>
}
function Appearance() {
  const { i18n } = useTranslation()
  const mode = useThemeStore(s => s.mode)
  const setMode = useThemeStore(s => s.setMode)
  const scale = useUiPrefsStore(s => s.scale)
  const setScale = useUiPrefsStore(s => s.setScale)
  return <div className="grid gap-4">
    <Field label="语言"><select aria-label="语言" className={selectClass} value={i18n.language} onChange={e => void i18n.changeLanguage(e.target.value)}>
      {SUPPORTED_LANGS.map(value => <option key={value} value={value}>{LANG_LABELS[value]}</option>)}
    </select></Field>
    <Field label="显示模式"><select aria-label="显示模式" className={selectClass} value={mode} onChange={e => setMode(e.target.value as ThemeMode)}>
      <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
    </select></Field>
    <Field label={`界面缩放 ${Math.round(scale * 100)}%`}><input aria-label="界面缩放" type="range" min={SCALE_MIN} max={SCALE_MAX} step={SCALE_STEP} value={scale} onChange={e => setScale(Number(e.target.value))} /></Field>
    <p className="text-xs text-muted-foreground">界面设置即时生效并保存。</p>
  </div>
}
function Updates() {
  const updater = useUpdaterStore()
  const [version, setVersion] = useState('—')
  useEffect(() => { void invoke<string>('get_teacher_version').then(setVersion).catch(() => {}); void useUpdaterStore.getState().checkNow(false) }, [])
  return <div className="grid gap-4 text-sm">
    <div className="flex items-center justify-between"><span>当前版本</span><span className="font-mono">{version}</span></div>
    <label className="flex items-center justify-between">自动检查更新<Switch aria-label="自动检查更新" checked={updater.autoCheckEnabled} onCheckedChange={updater.setAutoCheckEnabled} /></label>
    <Button variant="outline" disabled={updater.checking} onClick={() => void updater.checkNow(true)}>{updater.checking ? '正在检查…' : '检查更新'}</Button>
    {updater.lastError && <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3"><p role="alert" className="text-xs text-destructive">暂时无法检查更新，请稍后重试。</p><details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">查看详情</summary><p className="mt-2 break-all">{updater.lastError}</p></details></div>}
    <Button variant="ghost" onClick={() => {void openExternal('https://github.com/xcymm3/Akagi-Teacher/releases/latest')}}>前往 GitHub 发布页</Button>
    {updater.pendingUpdate ? <div className="grid gap-2"><span>发现版本 {updater.pendingUpdate.latest_version}</span><Button onClick={updater.openDialog}>查看更新与下载</Button></div>
      : updater.checkedThisSession && !updater.checking && !updater.lastError && <p className="text-xs text-muted-foreground">当前已是最新版本</p>}
    {updater.skippedVersion && <Button variant="ghost" onClick={updater.clearSkipped}>恢复提醒已跳过的版本</Button>}
  </div>
}
