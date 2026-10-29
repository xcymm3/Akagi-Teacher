import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useCoach } from '@/hooks/useCoach'
import { formatCoach } from '@/lib/coach'
import { Mahgen } from '@/components/Mahgen'
import { hexToRgba } from '@/lib/botShow'
import { mjaiToMahgen } from '@/lib/tileIdx'
import { cn } from '@/lib/utils'
import type { ShowItem, ShowMeta } from '@/types'

// The bot's `meta.show` rows, rendered once and used twice: by the Bot Show
// dashboard tile and by the always-on-top overlay window. Purely presentational
// — see `@/lib/botShow` for the helpers that turn a `bot-response` into rows.
//
// The two variants differ in which axis drives the tile size, and that is the
// whole reason they can't share one layout:
//
// - `tile` — rows hug their content and the list scrolls inside a dashboard
//   tile that may be any height. Tile size follows the list's *width*.
// - `overlay` — the window is small and its height is the scarce axis. Rows
//   split the available height between them and each tile fills its own row, so
//   the list always reaches the bottom edge and the tiles grow when the user
//   drags the window taller. (Width-driven sizing here left a dead band under
//   the last row and tiles too small to read at a glance.)

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
    <div className={cn('flex flex-col gap-2', overlay && !coach.available && 'h-full')}>
    {coach.available && <p className="text-[11px] text-muted-foreground">
      {zh ? '百分比为模型偏好' : 'Percentages are model preferences'}
    </p>}
    <ol
      ref={containerRef}
      className={cn('flex flex-col gap-1', overlay && !coach.available && 'h-full', className)}
    >
      {items.map((it, i) => {
        const seq = it.tiles ?? (it.pais ? mjaiToMahgen(it.pais) : '')
        return (
          <li
            key={i}
            className={cn(
              'flex flex-wrap items-center gap-2 overflow-hidden rounded-md border border-border px-2',
              // flex-1 + min-h-0: the row's height comes from the window, not
              // from the tile inside it — which is what stops the tile's own
              // growth from feeding back into the measurement.
              overlay && !coach.available ? 'min-h-0 flex-1' : 'py-1.5',
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
                kind={coach.available ? 'coach-show' : overlay ? 'overlay-show' : 'bot-show'}
                // Overlay tiles measure their own row, so they must NOT be
                // handed the list element: Mahgen falls back to the parent <li>.
                containerRef={overlay ? undefined : containerRef}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              {(text?.labels[i] || it.label) && (
                <span className="truncate text-sm text-foreground">{text?.labels[i] ?? it.label}</span>
              )}
              {it.note && (
                <span className="truncate text-[10px] text-muted-foreground">{it.note}</span>
              )}
            </div>
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
              {text?.markers[i]?.length ? <span className="flex gap-1 text-xs font-semibold">
                {text.markers[i].map(marker => <span key={marker} className="rounded bg-muted px-1" title={marker === '守' || marker === 'Defend' ? (zh ? '对已立直者的现物防守' : 'Genbutsu against a riichi player') : (zh ? '牺牲牌效，争取打点；未计算番数' : 'Trades efficiency for potential value; han not calculated')}>{marker}</span>)}
              </span> : null}
              </div>
            )}
            {coach.available && i < 3 && (!text || text.reasons[i]) && <p className="w-full whitespace-normal break-words text-xs leading-relaxed text-foreground/90">
              {text?.reasons[i] ?? (coach.pending
                ? (zh ? '正在分析…' : 'Analyzing this decision…')
                : (zh ? '暂无法取得解释。' : 'Explanation unavailable; the original recommendation is unchanged.'))}
            </p>}
          </li>
        )
      })}
    </ol>
    {text?.summary && <div className="rounded-md border border-border bg-muted/30 p-2 text-xs leading-relaxed" role="note">
      <strong>{zh ? '局面解读：' : 'Hand analysis: '}</strong>{text.summary}

    </div>}
    </div>
  )
}
