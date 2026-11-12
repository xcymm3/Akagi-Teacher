import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GripHorizontal, Power, X } from 'lucide-react'
import { BotShowList } from '@/components/BotShowList'
import { pickShow, visibleItems } from '@/lib/botShow'
import { invoke, listen } from '@/lib/tauri'
import type { AppConfig, BotResponse, MjaiEvent, OverlayConfig, ShowMeta } from '@/types'

// Compact suggestion window. Only the title bar is a drag region; controls
// and the scrolling analysis body remain interactive.

// Only used if `get_config` fails — a blank overlay would be worse than a
// default-looking one. Mirrors `OverlayConfig::default()`.
const FALLBACK: OverlayConfig = {
  enabled: true,
  top_n: 3,
  opacity: 0.95,
  always_on_top: true,
}

export function Overlay() {
  const { t } = useTranslation()
  const [show, setShow] = useState<ShowMeta | null>(null)
  const [autoplay, setAutoplay] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [cfg, setCfg] = useState<OverlayConfig>(FALLBACK)

  useEffect(() => {
    const unlistens: Array<() => void> = []
    let cancelled = false

    // The window is opened by the backend, so config is already on disk;
    // `overlay-config` keeps us in step with later edits in Settings.
    invoke<AppConfig>('get_config')
      .then((c) => {
        if (!cancelled) { setCfg(c.overlay); setAutoplay(c.autoplay.enabled); setReady(true) }
      })
      .catch(() => {
        /* keep the fallback — a blank overlay would be worse than a default one */
      })

    listen<BotResponse>('bot-response', (r) => {
      const s = pickShow(r.meta)
      // Responses without a `show` block (e.g. a bare `none`) must not wipe
      // the last real suggestion off the screen.
      if (s) setShow(s)
    }).then((u) => unlistens.push(u))

    listen<boolean>('autoplay-config', (enabled) => { setAutoplay(enabled); setReady(true) }).then((u) => unlistens.push(u))

    listen<OverlayConfig>('overlay-config', (c) => setCfg(c)).then((u) => unlistens.push(u))
    listen<MjaiEvent>('mjai-event', (e) => {
      if (['start_game', 'start_kyoku', 'end_kyoku', 'end_game'].includes(e.type)) setShow(null)
    }).then((u) => unlistens.push(u))

    return () => {
      cancelled = true
      unlistens.forEach((u) => u())
    }
  }, [])

  const items = visibleItems(show, show?.coach ? 3 : cfg.top_n)
  const close = () => { void invoke('set_overlay_enabled', { enabled: false }).catch(() => {}) }

  const changeAutoplay = async (enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      await invoke('set_autoplay_enabled', { enabled })
      setAutoplay(enabled)
      setConfirming(false)
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="h-screen w-screen overflow-hidden p-1 select-none">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg" style={{ opacity: cfg.opacity }}>
        <header data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/80 px-2 cursor-grab active:cursor-grabbing">
          <GripHorizontal className="size-4 pointer-events-none text-muted-foreground" />
          <span data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center truncate text-xs font-semibold">
            {show?.title ?? t('tile.bot_show_default_title')}
          </span>
          <button type="button" role="switch" aria-checked={autoplay} aria-label="自动打牌" disabled={busy || !ready}
            title={autoplay ? '关闭自动打牌' : '开启自动打牌'}
            onClick={() => autoplay ? void changeAutoplay(false) : (setError(''), setConfirming(true))}
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs cursor-pointer disabled:opacity-50 ${autoplay ? 'bg-green-600 text-white' : 'bg-background text-muted-foreground hover:text-foreground'}`}>
            <Power className="size-3.5" />自动{autoplay ? '开' : '关'}
          </button>
          <button type="button" onClick={close} aria-label={t('overlay.close')} title={t('overlay.close')} className="shrink-0 rounded p-1.5 cursor-pointer text-muted-foreground hover:bg-background hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>
        {confirming && <div role="alertdialog" aria-label="确认开启自动打牌" className="shrink-0 border-b border-border bg-muted p-2 text-xs">
          <p>开启后会自动操作：意见一致时跟随首选；分歧时模型概率大于60%跟随模型，否则跟随教师。</p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => { setConfirming(false); setError('') }} className="rounded border px-2 py-1">取消</button>
            <button type="button" disabled={busy} onClick={() => void changeAutoplay(true)} className="rounded bg-primary px-2 py-1 text-primary-foreground">{busy ? '启用中…' : '确认启用'}</button>
          </div>
        </div>}
        {error && <p role="alert" className="shrink-0 px-2 py-1 text-xs text-red-500">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-1.5 py-1.5">
          {items.length === 0 ? <span className="px-1 text-xs text-muted-foreground">{t('overlay.empty')}</span>
            : <BotShowList items={items} show={show} variant="overlay" />}
        </div>
      </div>
    </div>
  )
}
