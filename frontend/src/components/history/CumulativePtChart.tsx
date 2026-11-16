// Cumulative PT line chart. X axis = game ordinal (oldest → newest);
// Y axis = running total PT under the active rule. Hover tooltip shows
// the date + per-game delta.

import { useTranslation } from 'react-i18next'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { CumulativePoint } from '@/lib/ptCalc'

export function CumulativePtChart({ series, label:seriesLabel }: { series: CumulativePoint[]; label?: string }) {
  const { t } = useTranslation()

  if (series.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-12 text-center">
        {t('history.no_data')}
      </div>
    )
  }

  const data = series.map((p) => ({
    index: p.index + 1,
    cumulative: p.cumulative,
    delta: p.delta,
    started_at: p.record.started_at,
    rank: p.record.our_rank,
  }))

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="index" stroke="var(--color-muted-foreground)" fontSize={12} />
          <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
          <ReferenceLine y={0} stroke="var(--color-muted-foreground)" strokeDasharray="2 2" />
          <Tooltip
            contentStyle={{
              background: 'var(--color-popover)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              color: 'var(--color-popover-foreground)',
            }}
            labelFormatter={(_label, payload) => {
              const arr = payload as
                | ReadonlyArray<{ payload?: { started_at: string; rank: number | null } }>
                | undefined
              const p = arr?.[0]?.payload
              if (!p) return ''
              const date = new Date(p.started_at).toLocaleString()
              return `${date} · ${t('history.table.rank')} ${p.rank ?? '—'}`
            }}
            formatter={(value, name) => {
              const v = typeof value === 'number' ? value : Number(value)
              const label =
                String(name) === 'cumulative' ? seriesLabel ?? t('history.cumulative_pt') : 'Δ'
              return [v.toFixed(1), label]
            }}
          />
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            dot={{ r: 2 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
