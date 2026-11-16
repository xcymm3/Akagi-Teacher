/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
// Read-only accessory window. Opening it never hides the embedded game.
import { useEffect, useState } from 'react'
import { History, ScrollText, ChevronRight } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AccessoryHistory } from '@/components/AccessoryTools'
import { Logs } from '@/routes/Logs'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { UpdateDialog } from '@/components/UpdateDialog'
import { useTauriBridge } from '@/hooks/useTauriBridge'
import { useUiPreferences } from '@/hooks/useUiPreferences'
import { useUpdaterStore } from '@/stores/updaterStore'
import { HAS_TAURI } from '@/lib/tauri'

const NAV = [
  {id:'history',label:'历史记录',description:'对局统计、结算与牌谱',icon:History},
  {id:'logs',label:'日志查看',description:'运行日志与事件检查',icon:ScrollText},
] as const
type Tab = typeof NAV[number]['id']
function initialTab(): Tab {
  return new URLSearchParams(window.location.search).get('settingsTab') === 'logs' ? 'logs' : 'history'
}
export function Settings() {
  useUiPreferences()
  useTauriBridge()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const applying = useUpdaterStore(s => s.applying)
  const current = NAV.find(item => item.id === tab)!
  useEffect(() => {
    let active = true
    const show = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (value === 'history' || value === 'logs') setTab(value)
    }
    // Updates remain a transient notification flow, without a settings page.
    const showUpdate = () => {
      void useUpdaterStore.getState().checkNow(false).then(() => {
        if (active && useUpdaterStore.getState().pendingUpdate) useUpdaterStore.getState().openDialog()
      })
    }
    window.addEventListener('show-settings-tab', show)
    window.addEventListener('show-update-dialog', showUpdate)
    if (new URLSearchParams(window.location.search).get('showUpdate') === '1') showUpdate()
    return () => {
      active = false
      window.removeEventListener('show-settings-tab', show)
      window.removeEventListener('show-update-dialog', showUpdate)
    }
  }, [])
  useEffect(() => {
    if (!HAS_TAURI) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onCloseRequested(event => {
      if (applying) {
        event.preventDefault()
        setNotice('更新进行中，请先取消下载或等待完成。')
      }
    }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(e => setError(String(e)))
    return () => { disposed = true; unlisten?.() }
  }, [applying])
  const close = async () => {
    if (!HAS_TAURI || applying) return
    try { await getCurrentWindow().close() }
    catch (e) { setError(String(e)) }
  }
  return <main aria-label="历史与日志" className="flex h-screen min-h-0 bg-background text-foreground">
    <nav aria-label="工具分类" className="flex w-40 shrink-0 flex-col border-r border-border/70 bg-muted/25 px-3 py-5" role="tablist" aria-orientation="vertical">
      <div className="mb-7 px-3"><div className="text-base font-semibold tracking-tight">Akagi<span className="ml-1.5 text-xs font-normal text-muted-foreground">教师版</span></div><p className="mt-1 text-[11px] text-muted-foreground">历史与日志</p></div>
      {NAV.map(({id,label,icon:Icon}) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => setTab(id)}
        className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring active:bg-muted ${tab === id ? 'bg-background font-medium text-foreground shadow-xs ring-1 ring-border/70' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}>
        <Icon className="size-4 shrink-0" strokeWidth={1.7} />{label}{tab === id && <ChevronRight className="ml-auto size-3 text-muted-foreground" />}
      </button>)}
    </nav>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border/60 px-6 py-5"><h1 className="text-lg font-semibold tracking-tight">{current.label}</h1><p className="mt-1 text-xs text-muted-foreground">{current.description}</p></header>
      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className={`min-h-0 flex-1 bg-muted/10 ${tab === 'logs' ? 'flex flex-col overflow-hidden p-4' : 'overflow-y-auto p-6'}`}>
        {tab === 'history' ? <AccessoryHistory /> : <Logs embedded />}
      </section>
      <footer className="grid shrink-0 gap-2 border-t border-border px-4 py-3">
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        <div className="flex justify-end"><Button size="sm" variant="outline" disabled={applying} onClick={() => void close()}>关闭</Button></div>
      </footer>
    </div>
    <Toaster /><UpdateDialog />
  </main>
}
