import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GripHorizontal, X } from 'lucide-react'
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
            onClick={() => void changeAutoplay(!autoplay)}
            className="flex shrink-0 items-center gap-2 rounded px-1 py-1 text-xs cursor-pointer text-foreground disabled:opacity-50">
            <span>自动打牌</span>
            <span aria-hidden="true" className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${autoplay ? 'bg-green-600' : 'bg-muted-foreground/40'}`}>
              <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-150" style={{ transform: `translateX(${autoplay ? 16 : 0}px)` }} />
            </span>
          </button>
          <button type="button" onClick={close} aria-label={t('overlay.close')} title={t('overlay.close')} className="shrink-0 rounded p-1.5 cursor-pointer text-muted-foreground hover:bg-background hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>
        {error && <p role="alert" className="shrink-0 px-2 py-1 text-xs text-red-500">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-1.5 py-1.5">
          {items.length === 0 ? <span className="px-1 text-xs text-muted-foreground">{t('overlay.empty')}</span>
            : <BotShowList items={items} show={show} variant="overlay" />}
        </div>
      </div>
    </div>
  )
}
