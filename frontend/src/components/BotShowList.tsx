import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useCoach } from '@/hooks/useCoach'
import { formatCoach } from '@/lib/coach'
import { Mahgen } from '@/components/Mahgen'
import { hexToRgba } from '@/lib/botShow'
import { mjaiToMahgen } from '@/lib/tileIdx'
import { cn } from '@/lib/utils'
import type { ShowItem, ShowMeta } from '@/types'

// Shared candidate rendering; the overlay uses compact horizontal rows.

type Props = {
  items: ShowItem[]
  show?: ShowMeta | null
  /** `tile` variant only: the list element whose width drives tile sizing. */
  containerRef?: RefObject<HTMLOListElement | null>
  variant?: 'tile' | 'overlay'
  className?: string
}

export function BotShowList({ items, show, containerRef, variant = 'tile', className }: Props) {
  const overlay = variant === 'overlay'
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const coach = useCoach(show ?? null)
  const text = coach.facts ? formatCoach(coach.facts, i18n.language) : null

  return (
    <div className={cn('flex flex-col gap-1.5')}>
    {coach.available && !overlay && <p className="text-[11px] text-muted-foreground">
      {zh ? '百分比为模型偏好' : 'Percentages are model preferences'}
    </p>}
    <ol
      ref={containerRef}
      className={cn('flex flex-col gap-1', className)}
    >
      {items.map((it, i) => {
        const seq = it.tiles ?? (it.pais ? mjaiToMahgen(it.pais) : '')
        return (
          <li
            key={i}
            className={cn(
              'flex items-center gap-2 overflow-hidden rounded-md border border-border px-2',
              overlay ? 'flex-nowrap py-1' : 'flex-wrap py-1.5',
            )}
            style={{
              backgroundColor: hexToRgba(it.color, 0.1),
              borderLeftColor: it.color,
              borderLeftWidth: it.color ? 3 : undefined,
            }}
          >
            {seq && (
              <Mahgen
                seq={seq}
                kind={overlay ? 'overlay-compact' : coach.available ? 'coach-show' : 'bot-show'}
                // Overlay tiles measure their own row, so they must NOT be
                // handed the list element: Mahgen falls back to the parent <li>.
                containerRef={overlay ? undefined : containerRef}
              />
            )}
            {text?.markers[i]?.length ? <span className="flex shrink-0 gap-1 text-xs font-semibold">
              {text.markers[i].map(marker => <span key={marker} className="rounded bg-muted px-1" title={zh ? '对所列对手的现物或同巡安全牌；同巡信息可能在摸牌或鸣牌后失效' : 'Genbutsu or a passed tile against the listed players; temporary safety expires after a draw or call'}>{marker}</span>)}
            </span> : null}
            <div className="flex min-w-0 flex-1 flex-col">
              {(text?.labels[i] || it.label) && (
                <span className="truncate text-sm text-foreground">{text?.labels[i] ?? it.label}</span>
              )}
              {it.note && (
                <span className="truncate text-[10px] text-muted-foreground">{it.note}</span>
              )}
            </div>
            {overlay && coach.available && i < 3 && <p title={[text?.reasons[i], text?.details[i]].filter(Boolean).join('\n')} className="min-w-0 flex-[4] whitespace-normal break-words text-xs leading-snug text-foreground/90">
              {text?.reasons[i] ?? (coach.pending ? (zh ? '分析中…' : 'Analyzing…') : '')}
            </p>}
            {it.value && (
              <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span
                className={cn(
                  'font-mono tabular-nums text-foreground/90',
                  overlay ? 'text-sm' : 'text-xs',
                )}
              >
                {it.value}
              </span>
              </div>
            )}
            {!overlay && coach.available && i < 3 && (!text || text.reasons[i]) && <p title={text?.details[i]} className="w-full whitespace-normal break-words text-xs leading-relaxed text-foreground/90">
              {text?.reasons[i] ?? (coach.pending
                ? (zh ? '正在分析…' : 'Analyzing this decision…')
                : (zh ? '暂无法取得解释。' : 'Explanation unavailable; the original recommendation is unchanged.'))}
            </p>}
          </li>
        )
      })}
    </ol>
    {text?.summary && <div className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs leading-snug" role="note">
      <strong>{zh ? '局面解读：' : 'Hand analysis: '}</strong>{text.summary}

    </div>}
    </div>
  )
}
