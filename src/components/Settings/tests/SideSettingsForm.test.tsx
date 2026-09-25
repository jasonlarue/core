import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SideSettingsForm } from '../SideSettingsForm'

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ settings: { getAll: { invalidate: state.invalidate } } }),
    settings: { updateSide: { useMutation: () => ({ mutate: state.mutate, isPending: false, error: null }) } },
  },
}))

const base = {
  side: 'left' as const,
  name: 'Left',
  awayMode: false,
  alwaysOn: false,
  autoOffEnabled: false,
  autoOffMinutes: 30,
}

function renderForm(extra: Partial<{ age: number | null, sex: 'female' | 'male' | null }> = {}) {
  return render(<SideSettingsForm side="left" sideData={{ ...base, ...extra }} presenceAvailable />)
}

beforeEach(() => state.mutate.mockReset())
afterEach(cleanup)

describe('SideSettingsForm sleeper profile', () => {
  it('shows stored age and sex', () => {
    renderForm({ age: 38, sex: 'male' })
    expect((screen.getByLabelText('Age') as HTMLInputElement).value).toBe('38')
    expect(screen.getByRole('button', { name: 'Male' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('saves a valid age on blur', () => {
    renderForm()
    const input = screen.getByLabelText('Age')
    fireEvent.change(input, { target: { value: '41' } })
    fireEvent.blur(input)
    expect(state.mutate).toHaveBeenCalledWith({ side: 'left', age: 41 })
  })

  it('clears age when emptied', () => {
    renderForm({ age: 41 })
    const input = screen.getByLabelText('Age')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(state.mutate).toHaveBeenCalledWith({ side: 'left', age: null })
  })

  it.each(['0', '121', '30.5'])('reverts invalid age %s without saving', (value) => {
    renderForm({ age: 41 })
    const input = screen.getByLabelText('Age') as HTMLInputElement
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
    expect(state.mutate).not.toHaveBeenCalled()
    expect(input.value).toBe('41')
  })

  it('does not save an unchanged age', () => {
    renderForm({ age: 41 })
    fireEvent.blur(screen.getByLabelText('Age'))
    expect(state.mutate).not.toHaveBeenCalled()
  })

  it('saves sex, including clearing it', () => {
    renderForm({ sex: 'female' })
    fireEvent.click(screen.getByRole('button', { name: 'Male' }))
    expect(state.mutate).toHaveBeenLastCalledWith({ side: 'left', sex: 'male' })
    fireEvent.click(screen.getByRole('button', { name: 'Not set' }))
    expect(state.mutate).toHaveBeenLastCalledWith({ side: 'left', sex: null })
    fireEvent.click(screen.getByRole('button', { name: 'Not set' }))
    expect(state.mutate).toHaveBeenCalledTimes(2) // re-selecting is a no-op
  })
})
