// Per-game detail dialog. Shows the recorded player's perspective: who
// played, final standings (rank / score / Δ), and the per-game stats.
// Mirrors the GameRecord shape directly — no re-aggregation needed.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, SearchCheck, Share2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useGameReviewStatus } from '@/components/review/gameReviewStatus'
import { openExternal } from '@/lib/external'
import { matchGameId, paifuUrl, roomLabelKey } from '@/lib/matchInfo'
import { useReviewStore } from '@/stores/reviewStore'
import type { GameRecord } from '@/types'

const STARTING_4P = 25_000
const STARTING_3P = 35_000

export function GameDetailDialog({
  record,
  onOpenChange,
  onReview,
  localOnly = false,
}: {
  localOnly?: boolean
  record: GameRecord | null
  onOpenChange: (open: boolean) => void
  /** Open the review submit flow for this game (the caller closes this
   *  dialog first — stacked modals would bury the confirm step). */
  onReview?: (record: GameRecord) => void
}) {
  const { t } = useTranslation()
  const open = record !== null
  const start = record?.num_players === 3 ? STARTING_3P : STARTING_4P
  const room = roomLabelKey(record?.match_info)
  const gameId = matchGameId(record?.match_info)
  const replayUrl = paifuUrl(record?.match_info, record?.our_seat)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-2xl, not max-w-2xl: DialogContent ships its own
          `sm:max-w-sm`, and only a same-variant class replaces it through
          cn's tailwind-merge — a base max-w-* silently loses at ≥sm. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('history.detail.title')}</DialogTitle>
          {record && (
            <DialogDescription className="font-mono text-xs break-all">
              {record.id}
            </DialogDescription>
          )}
        </DialogHeader>
        {record && (
          <div className="space-y-4">
            <Section title={t('history.detail.started_at')}>
              <span className="font-mono text-sm">
                {new Date(record.started_at).toLocaleString()}
              </span>
            </Section>
            <Section title={t('history.detail.ended_at')}>
              <span className="font-mono text-sm">
                {new Date(record.ended_at).toLocaleString()}
              </span>
            </Section>
            <Section title={t('history.detail.platform')}>
              <span className="text-sm">
                {t(`platform.${record.platform}`)}
              </span>
            </Section>
            <Section title={t('history.detail.mode')}>
              <span className="text-sm">
                {record.num_players}p ·{' '}
                {record.kyoku_mode === 'east_only'
                  ? t('history.filter.east_only')
                  : record.kyoku_mode === 'east_south'
                    ? t('history.filter.east_south')
                    : t('history.filter.other')}
              </span>
            </Section>
            {room && (
              <Section title={t('history.detail.room')}>
                <span className="text-sm">{t(room.key, room.params)}</span>
              </Section>
            )}
            {gameId && (
              <Section title={t('history.detail.game_id')}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs break-all">{gameId}</span>
                  {replayUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 shrink-0"
                      onClick={() => openExternal(replayUrl)}
                    >
                      <ExternalLink className="h-3 w-3 mr-1" />
                      {t('history.detail.open_paifu')}
                    </Button>
                  )}
                </div>
              </Section>
            )}

            {!localOnly && <ReviewSection record={record} onReview={onReview} />}

            <Section title={t('history.detail.final')}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>{t('history.table.names')}</TableHead>
                    <TableHead className="text-right">
                      {t('history.table.end_score')}
                    </TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Order rows by rank (1..N) so the dialog reads top-to-bottom. */}
                  {record.final_ranks
                    .map((rank, seat) => ({ rank, seat }))
                    .sort((a, b) => a.rank - b.rank)
                    .map(({ rank, seat }) => {
                      const score = record.final_scores[seat]
                      const delta = score - start
                      const isUs = record.our_seat === seat
                      return (
                        <TableRow
                          key={seat}
                          className={isUs ? 'bg-accent/40' : ''}
                        >
                          <TableCell>{rank}</TableCell>
                          <TableCell>
                            {record.names[seat] || t('history.detail.seat_fallback', { seat })}
                            {isUs && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {t('history.detail.you_marker')}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {score.toLocaleString()}
                          </TableCell>
                          <TableCell
                            className={
                              'text-right font-mono ' +
                              (delta > 0
                                ? 'text-emerald-500'
                                : delta < 0
                                  ? 'text-red-500'
                                  : '')
                            }
                          >
                            {delta >= 0 ? '+' : ''}
                            {delta.toLocaleString()}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                </TableBody>
              </Table>
            </Section>

            <Section title={t('history.detail.stats')}>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-xs">
                <Stat label={t('mahjong.round')} value={record.stats.round} />
                <Stat label={t('mahjong.oya')} value={record.stats.oya} />
                <Stat label={t('mahjong.agari')} value={record.stats.agari} />
                <Stat label={t('mahjong.houjuu')} value={record.stats.houjuu} />
                <Stat label={t('mahjong.riichi')} value={record.stats.riichi} />
                <Stat label={t('mahjong.fuuro')} value={record.stats.fuuro} />
                <Stat label={t('mahjong.ryukyoku')} value={record.stats.ryukyoku} />
                <Stat label={t('mahjong.yakuman')} value={record.stats.yakuman} />
                <Stat
                  label={t('mahjong.nagashi_mangan')}
                  value={record.stats.nagashi_mangan}
                />
              </div>
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Review status + action for this game (Beta). Renders nothing when the
 *  feature can't apply (no API key configured, observer game). */
function ReviewSection({
  record,
  onReview,
}: {
  record: GameRecord
  onReview?: (record: GameRecord) => void
}) {
  const { t } = useTranslation()
  const status = useGameReviewStatus(record)
  const resolveShareUrl = useReviewStore((s) => s.resolveShareUrl)
  const reshare = useReviewStore((s) => s.reshare)
  const [busy, setBusy] = useState(false)

  if (status.kind === 'hidden') return null

  const openShare = async () => {
    if (status.kind !== 'reviewed') return
    setBusy(true)
    const url = await resolveShareUrl(status.share)
    setBusy(false)
    if (url) openExternal(url)
  }

  const reissue = async () => {
    setBusy(true)
    const url = await reshare(record.id)
    setBusy(false)
    if (url) openExternal(url)
  }

  return (
    <Section title={t('review.title')}>
      <div className="flex items-center gap-2">
        {status.kind === 'none' ? (
          onReview && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReview(record)}
            >
              <SearchCheck className="h-3.5 w-3.5" />
              {t('review.review_this_game')}
            </Button>
          )
        ) : status.kind === 'reviewing' ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('review.job_title')}
          </span>
        ) : status.kind === 'revoked' ? (
          <>
            <Badge variant="outline">{t('review.status_link_revoked')}</Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void reissue()}
            >
              <Share2 className="h-3.5 w-3.5" />
              {t('review.reshare')}
            </Button>
          </>
        ) : (
          // reviewed / reviewed_loading
          <>
            <Badge
              variant="secondary"
              className="text-emerald-500"
            >
              {t('review.status_reviewed')}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || status.kind === 'reviewed_loading'}
              onClick={() => void openShare()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('review.open_review')}
            </Button>
          </>
        )}
      </div>
    </Section>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/40 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}
