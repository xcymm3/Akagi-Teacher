import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Logs } from './Logs'
import { useLogsStore } from '@/stores/logsStore'
import { useInspectorStore } from '@/stores/inspectorStore'
import '@/i18n'
const { invoke } = vi.hoisted(() => ({invoke:vi.fn()}))
vi.mock('@/lib/tauri', () => ({invoke}))
vi.mock('./DiagnosticView', () => ({DiagnosticView: () => <p>日志列表</p>}))
vi.mock('./InspectorView', () => ({InspectorView: () => <p>事件列表</p>}))
describe('embedded log viewer', () => {
  beforeEach(() => {
    useLogsStore.setState({sessions:[],currentSession:null,activeSession:null})
    invoke.mockReset().mockImplementation((name:string) => Promise.resolve(name === 'list_log_sessions' ? [{name:'session-1',path:'logs/session-1',size_bytes:100,mtime_ms:0,is_active:true}] : {entries:[],has_more:false,skipped_malformed:0}))
  })
  it('reads active session logs and inspector without modifying configuration or game state', async () => {
    render(<Logs embedded />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('read_log_session',{req:{session:'session-1',offset:0,limit:2000}}))
    expect(invoke).toHaveBeenCalledWith('read_inspector',{req:{session:'session-1',offset:0,limit:2000}})
    expect(screen.queryByRole('heading')).toBeNull()
    expect(useLogsStore.getState().currentSession).toBe('session-1')
    expect(useInspectorStore.getState().entries).toEqual([])
    expect(invoke.mock.calls.every(([name]) => ['list_log_sessions','read_log_session','read_inspector'].includes(name))).toBe(true)
  })
})
