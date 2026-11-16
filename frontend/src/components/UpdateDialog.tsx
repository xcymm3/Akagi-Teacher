import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { openExternal } from '@/lib/external'
import { selectHasNotifiableUpdate, useUpdaterStore } from '@/stores/updaterStore'

/// Modal dialog for the in-app update flow. Opened by the sidebar
/// red-dot click, the "View details" toast action, or the Settings
/// "Update available" button. Footer actions match the four user
/// choices (Update now / Skip / Later / Open release page).
export function UpdateDialog() {
  const { t } = useTranslation()
  const open = useUpdaterStore((s) => s.dialogOpen)
  const closeDialog = useUpdaterStore((s) => s.closeDialog)
  const pending = useUpdaterStore((s) => s.pendingUpdate)
  const applying = useUpdaterStore((s) => s.applying)
  const applyUpdate = useUpdaterStore((s) => s.applyUpdate)
  const cancelUpdate = useUpdaterStore((s) => s.cancelUpdate)
  const progress = useUpdaterStore((s) => s.progress)
  const started = useUpdaterStore((s) => s.applyStartedAt)
  const lastError = useUpdaterStore((s) => s.lastError)
  const progressAt = useUpdaterStore((s) => s.progressAt)
  const [now,setNow] = useState(Date.now)
  useEffect(() => {
    if(!applying)return
    const timer=window.setInterval(()=>setNow(Date.now()),1000)
    return ()=>window.clearInterval(timer)
  },[applying,started])
  const elapsed=Math.max(0,Math.floor((now-(started ?? now))/1000))
  const bytes=progress?.downloaded ?? 0
  const total=progress?.total ?? pending?.asset_size ?? 0
  const percent=total>0 ? Math.min(100,Math.max(0,bytes/total*100)) : 0
  const mib=(value:number)=>(value/1024/1024).toFixed(1)
  const phase=progress?.stage ?? 'checking'
  const phaseLabel={checking:'正在检查更新条件',connecting:'正在连接 GitHub 下载服务器',downloading:'正在下载',verifying:'正在校验文件',installing:'正在替换程序，请勿关闭',restarting:'正在重启程序',cancelling:'正在取消下载',cancelled:'更新已取消',failed:'更新失败'}[phase]
  const idle=Math.max(0,Math.floor((now-(progressAt ?? now))/1000))
  const skip = useUpdaterStore((s) => s.skip)
  const hasNotifiable = useUpdaterStore(selectHasNotifiableUpdate)

  // Closing the dialog without any pending update is a no-op; mount-state
  // is intentionally driven entirely by the store so other components
  // (sidebar / settings) can trigger it without prop drilling.
  if (!pending) return null

  const handleUpdate = async () => {
    const err = await applyUpdate()
    // On success applyUpdate never returns (backend restart). Only
    // failures land here.
    if (!err) return
    const fallback = () => openExternal(pending.html_url)
    switch (err.kind) {
      case 'cancelled':
        return
      case 'read_only_install':
        toast.error(t('updates.dialog.error_read_only'), {
          action: { label: t('updates.dialog.open_release'), onClick: fallback },
        })
        break
      case 'unsupported_platform':
        toast.error(t('updates.dialog.error_unsupported_platform'), {
          action: { label: t('updates.dialog.open_release'), onClick: fallback },
        })
        break
      case 'no_matching_asset':
        toast.error(t('updates.dialog.error_no_matching_asset'), {
          action: { label: t('updates.dialog.open_release'), onClick: fallback },
        })
        break
      case 'digest_mismatch':
        toast.error(t('updates.dialog.error_digest_mismatch'), {
          action: { label: t('updates.dialog.open_release'), onClick: fallback },
        })
        break
      case 'signature_missing':
        toast.error(t('updates.dialog.error_signature_missing'), {
          action: { label: t('updates.dialog.open_release'), onClick: fallback },
        })
        break
      case 'signature_invalid':
        toast.error(t('updates.dialog.error_signature_invalid'), {
          action: { label: t('updates.dialog.open_release'), onClick: fallback },
        })
        break
      default:
        toast.error(t('updates.dialog.error_generic', { message: err.message }))
    }
  }

  return (
    <Dialog open={open && hasNotifiable} onOpenChange={(v) => !v && closeDialog()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('updates.dialog.title', { version: pending.latest_version })}</DialogTitle>
          <DialogDescription>{t('updates.dialog.runtime_caveat')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 max-h-[50vh] overflow-y-auto">
          <h3 className="text-sm font-semibold text-muted-foreground">
            {t('updates.dialog.notes_heading')}
          </h3>
          {/* Plain pre-formatted text. We don't pull a markdown renderer
              for this single use — release notes are short and the
              monospace block reads fine. */}
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed font-mono">
            {pending.body.trim() || t('updates.dialog.no_notes')}
          </pre>
        </div>
        {progress && <div className="space-y-2 text-sm" aria-live="polite">
          <p>{phaseLabel}{applying ? ` · 已用时 ${elapsed} 秒` : ''}</p>
          {applying && <>
            <div role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={phase === 'connecting' || phase === 'checking' ? undefined : Math.round(percent)}
              className="h-2 overflow-hidden rounded bg-muted">
              <div className={`h-full bg-primary transition-[width] ${phase === 'connecting' || phase === 'checking' ? 'animate-pulse' : ''}`}
                style={{width:phase === 'connecting' || phase === 'checking' ? '30%' : `${percent}%`}} />
            </div>
            <p className="text-xs text-muted-foreground">{mib(bytes)} / {mib(total)} MiB · {percent.toFixed(1)}%{phase === 'downloading' ? ` · 平均 ${mib(bytes/Math.max(1,elapsed))} MiB/s` : ''}</p>
            {phase === 'downloading' && idle >= 5 && <p className="text-xs text-amber-500">已 {idle} 秒未收到新数据；连续30秒没有数据会停止并报错。</p>}
          </>}
          {lastError && <p role="alert" className="break-words text-xs text-destructive">{lastError}</p>}
        </div>}
        <DialogFooter className="bg-transparent p-0 border-0 mx-0 mb-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openExternal(pending.html_url)}
          >
            {t('updates.dialog.open_release')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => skip(pending.latest_tag)}
            disabled={applying}
          >
            {t('updates.dialog.skip')}
          </Button>
          <Button variant="secondary" size="sm" onClick={closeDialog} disabled={applying}>
            {t('updates.dialog.later')}
          </Button>
          {applying && <Button variant="secondary" size="sm" onClick={() => void cancelUpdate()}
            disabled={['installing','restarting','cancelling'].includes(phase)}>取消下载</Button>}
          <Button size="sm" onClick={handleUpdate} disabled={applying}>
            {applying ? t('updates.dialog.applying') : t('updates.dialog.update_now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
