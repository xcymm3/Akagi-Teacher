import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Overlay } from './Overlay'

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke, listen }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/BotShowList', () => ({ BotShowList: ({ show }: { show?: { fold?: { active: boolean } } }) => <div>{show?.fold?.active ? '弃和测试' : '候选'}</div> }))

describe('overlay autoplay shortcut', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => {})
    invoke.mockImplementation((name: string) => Promise.resolve(name === 'get_config'
      ? { overlay: { enabled: true, top_n: 3, opacity: 1 }, autoplay: { enabled: false } }
      : undefined))
  })

  it('toggles immediately without confirmation or a settings save', async () => {
    render(<Overlay />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
    expect(invoke).toHaveBeenCalledWith('set_autoplay_enabled', { enabled: true })
    expect(invoke).not.toHaveBeenCalledWith('update_config', expect.anything())
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
    expect(invoke).toHaveBeenCalledWith('set_autoplay_enabled', { enabled: false })
  })

  it('shows backend errors and keeps autoplay disabled when enabling fails', async () => {
    render(<Overlay />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    invoke.mockRejectedValueOnce(new Error('需要 Chromium'))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chromium'))
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('keeps fold feedback at hand end and clears it at the next hand start', async () => {
    const callbacks = new Map<string, (value: unknown) => void>()
    listen.mockImplementation((name: string, callback: (value: unknown) => void) => { callbacks.set(name, callback); return Promise.resolve(() => {}) })
    render(<Overlay />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    act(() => callbacks.get('bot-response')?.({meta:{show:{items:[{label:'Discard',pais:['9p'],value:'60%'}],fold:{active:true}}}}))
    expect(screen.getByText('弃和测试')).toBeDefined()
    act(() => callbacks.get('mjai-event')?.({type:'end_kyoku'}))
    expect(screen.getByText('弃和测试')).toBeDefined()
    act(() => callbacks.get('mjai-event')?.({type:'start_kyoku'}))
    expect(screen.queryByText('弃和测试')).toBeNull()
  })

})
