import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Overlay } from './Overlay'

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ invoke, listen }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/BotShowList', () => ({ BotShowList: () => <div>候选</div> }))

describe('overlay autoplay shortcut', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => {})
    invoke.mockImplementation((name: string) => Promise.resolve(name === 'get_config'
      ? { overlay: { enabled: true, top_n: 3, opacity: 1 }, autoplay: { enabled: false } }
      : undefined))
  })

  it('requires confirmation, applies without a settings save, and stops directly', async () => {
    render(<Overlay />)
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(invoke).not.toHaveBeenCalledWith('set_autoplay_enabled', expect.anything())
    fireEvent.click(screen.getByText('取消'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByText('确认启用'))
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
    fireEvent.click(screen.getByText('确认启用'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chromium'))
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('alertdialog')).toBeDefined()
  })
})
