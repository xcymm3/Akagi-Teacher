import { Link, Outlet, useLocation } from 'react-router-dom'
import { GameRoom } from '@/routes/GameRoom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toaster } from '@/components/ui/sonner'
import { UpdateNotifier } from '@/components/UpdateNotifier'
import { useTauriBridge } from '@/hooks/useTauriBridge'
import { useUiPreferences } from '@/hooks/useUiPreferences'

export default function App() {
  useTauriBridge()
  useUiPreferences()
  const location = useLocation()
  return <>
    {location.pathname === '/' ? <GameRoom /> : <main className="flex h-screen min-w-0 flex-col bg-background text-foreground">
      <div className="shrink-0 border-b border-border px-4 py-2"><Link to="/" className="text-sm hover:underline">← 返回对局</Link></div>
      <div className="min-h-0 flex-1 overflow-auto"><ErrorBoundary key={location.pathname}><Outlet /></ErrorBoundary></div>
    </main>}
    <Toaster /><UpdateNotifier />
  </>
}
