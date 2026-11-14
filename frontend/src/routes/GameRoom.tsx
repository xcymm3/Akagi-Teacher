/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
// Existing theme, tile assets and teacher renderer; no additional dashboard.
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { History as HistoryIcon, RefreshCw, Settings } from 'lucide-react'
import { BotShowList } from '@/components/BotShowList'
import { GameDetailDialog } from '@/components/history/GameDetailDialog'
import { useEmbeddedGame } from '@/hooks/useEmbeddedGame'
import { invoke } from '@/lib/tauri'
import { visibleItems } from '@/lib/botShow'
import { roomShow } from '@/lib/roomShow'
import { useConfigStore } from '@/stores/configStore'
import { useCaptureStore } from '@/stores/captureStore'
import { useHistoryStore } from '@/stores/historyStore'
import { useNotifyStore } from '@/stores/notifyStore'
import type { GameRecord } from '@/types'

export function GameRoom() {
  const gameRef = useRef<HTMLDivElement>(null)
  const browserError = useEmbeddedGame(gameRef)
  const config = useConfigStore(s => s.config)
  const capture = useCaptureStore(s => s.status)
  const responses = useNotifyStore(s => s.responses)
  const events = useNotifyStore(s => s.events)
  const history = useHistoryStore(s => s.records)
  const loading = useHistoryStore(s => s.loading)
  const [selected, setSelected] = useState<GameRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const show = useMemo(() => roomShow(responses, events), [responses, events])
  const items = visibleItems(show, 3)
  const records = useMemo(() => history.filter(r => r.platform === 'majsoul')
    .toSorted((a,b) => b.started_at.localeCompare(a.started_at)).slice(0,30), [history])
  const autoplay = config?.autoplay.enabled ?? false
  const changeAutoplay = async () => {
    setBusy(true); setError('')
    try { await invoke('set_autoplay_enabled', { enabled: !autoplay }); useConfigStore.getState().setAutoplay(!autoplay) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const reload = async () => {
    setRefreshing(true); setError('')
    try { await invoke('reload_embedded_game') }
    catch (e) { setError(String(e)) }
    finally { setRefreshing(false) }
  }

  return <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
      <span className="min-w-0 truncate text-sm font-semibold">Akagi <span className="text-muted-foreground">教师版</span></span>
      <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block" role="status">
        {capture.state === 'running' ? '雀魂 · 数据捕获中' : capture.state === 'error' ? '连接失败，请检查设置' : '正在连接雀魂…'}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" role="switch" aria-label="自动打牌" aria-checked={autoplay}
          disabled={busy || !config} onClick={() => void changeAutoplay()}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted active:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50">
          自动打牌
          <span aria-hidden="true" className={`relative h-5 w-9 rounded-full transition-colors ${autoplay ? 'bg-green-600' : 'bg-muted-foreground/40'}`}>
            <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform" style={{ transform: `translateX(${autoplay ? 16 : 0}px)` }} />
          </span>
        </button>
        <button type="button" aria-label="刷新雀魂" title="刷新雀魂并重新连接" disabled={refreshing} onClick={() => void reload()}
          className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
        <Link to="/settings" aria-label="设置" title="设置与更新" className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><Settings className="size-4" /></Link>
      </div>
    </header>
    <main className="flex min-h-0 flex-1 max-md:flex-col">
      <section ref={gameRef} aria-label="雀魂游戏" className="relative min-w-0 flex-1 bg-muted/20 max-md:h-[40vh] max-md:min-h-[200px] max-md:flex-none">
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {browserError || '正在加载雀魂，首次使用请在游戏页面中登录。'}
        </div>
      </section>
      <aside aria-label="建议与记录" className="flex min-h-0 w-full flex-col border-l border-border md:w-[420px] md:max-w-[42%] max-md:flex-1">
        <section aria-label="三选一建议" className="shrink-0 border-b border-border p-3">
          <div className="mb-2 flex items-center justify-between"><h1 className="text-sm font-semibold">三选一建议</h1><span className="text-[11px] text-muted-foreground">模型偏好</span></div>
          {error && <p role="alert" className="mb-2 break-words text-xs text-red-500">{error}</p>}
          {items.length ? <BotShowList items={items} show={show} variant="overlay" />
            : <p className="py-5 text-center text-xs text-muted-foreground">进入对局后显示建议</p>}
        </section>
        <section aria-label="对局记录" className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between px-3 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><HistoryIcon className="size-4 text-muted-foreground" />对局记录</h2>
            <Link to="/history" className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">全部记录</Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {!records.length ? <p className="py-8 text-center text-xs text-muted-foreground">{loading ? '正在读取记录…' : '完成对局后，记录会自动保存在这里。'}</p>
              : <ol className="divide-y divide-border">{records.map(r => <li key={r.id}>
                <button type="button" onClick={() => setSelected(r)} className="flex w-full items-center gap-3 rounded px-1 py-3 text-left hover:bg-muted active:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="w-9 shrink-0 text-center font-mono text-lg tabular-nums">{r.our_rank ? `${r.our_rank}位` : '—'}</span>
                  <span className="min-w-0 flex-1"><span className="block text-xs">{r.num_players}人 · {r.kyoku_mode === 'east_only' ? '东风' : r.kyoku_mode === 'east_south' ? '半庄' : '对局'}</span>
                    <time className="mt-1 block text-[11px] text-muted-foreground">{new Date(r.started_at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</time></span>
                  <span className="shrink-0 text-right font-mono text-sm tabular-nums">{r.our_seat !== null ? r.final_scores[r.our_seat]?.toLocaleString() ?? '—' : '—'}
                    <span className={`mt-1 block text-[11px] ${(r.our_delta ?? 0) >= 0 ? 'text-green-600' : 'text-red-500'}`}>{r.our_delta === null ? '观战' : `${r.our_delta > 0 ? '+' : ''}${r.our_delta.toLocaleString()}`}</span></span>
                </button>
              </li>)}</ol>}
          </div>
        </section>
      </aside>
    </main>
    <GameDetailDialog record={selected} onOpenChange={open => { if (!open) setSelected(null) }} />
  </div>
}
