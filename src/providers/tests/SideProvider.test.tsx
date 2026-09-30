import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SideProvider, useSide } from '../SideProvider'

const state = vi.hoisted(() => ({
  sides: undefined as undefined | { left: { awayMode: boolean }, right: { awayMode: boolean } },
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { settings: { getAll: { useQuery: () => ({ data: state.sides ? { sides: state.sides } : undefined }) } } },
}))

type Ctx = ReturnType<typeof useSide>
let ctx: Ctx
const capture = (value: Ctx) => {
  ctx = value
}
function Probe({ onRender }: { onRender: (value: Ctx) => void }) {
  onRender(useSide())
  return null
}
const tree = () => <SideProvider><Probe onRender={capture} /></SideProvider>
const away = (left: boolean, right: boolean) => ({ left: { awayMode: left }, right: { awayMode: right } })

beforeEach(() => {
  localStorage.clear()
  document.cookie = 'sleepypod-side=; path=/; max-age=0' // cookie is the fallback store
  state.sides = away(false, false)
})
afterEach(cleanup)

describe('SideProvider single-sleeper mode', () => {
  it('reports no single sleeper and keeps the selection when neither side is away', () => {
    localStorage.setItem('sleepypod-selected-side', 'right')
    render(tree())
    expect(ctx.singleSleeperSide).toBeNull()
    expect(ctx.selectedSide).toBe('right')
    expect(ctx.activeSides).toEqual(['right'])
  })

  it('shows only the home side, unlinked, while the other side is away', () => {
    localStorage.setItem('sleepypod-selected-side', 'both')
    localStorage.setItem('sleepypod-is-linked', 'true')
    state.sides = away(false, true)
    render(tree())
    expect(ctx.singleSleeperSide).toBe('left')
    expect(ctx.selectedSide).toBe('left')
    expect(ctx.activeSides).toEqual(['left'])
    expect(ctx.primarySide).toBe('left')
    expect(ctx.isLinked).toBe(false)
  })

  it('follows the home side to the right', () => {
    state.sides = away(true, false)
    render(tree())
    expect(ctx.selectedSide).toBe('right')
    expect(ctx.activeSides).toEqual(['right'])
    expect(ctx.primarySide).toBe('right')
  })

  it('leaves the stored choice alone and applies it again when away mode ends', () => {
    localStorage.setItem('sleepypod-selected-side', 'both')
    localStorage.setItem('sleepypod-is-linked', 'true')
    state.sides = away(false, true)
    const { rerender } = render(tree())
    expect(ctx.activeSides).toEqual(['left'])
    expect(localStorage.getItem('sleepypod-selected-side')).toBe('both')
    state.sides = away(false, false)
    rerender(tree())
    expect(ctx.selectedSide).toBe('both')
    expect(ctx.isLinked).toBe(true)
    expect(ctx.activeSides).toEqual(['left', 'right'])
  })

  it('restores a selection an earlier version set aside, once', () => {
    localStorage.setItem('sleepypod-selected-side', 'both')
    localStorage.setItem('sleepypod-is-linked', 'true')
    localStorage.setItem('sleepypod-single-sleeper-side', 'left')
    localStorage.setItem('sleepypod-pre-single-sleeper-selection', JSON.stringify({ side: 'right', linked: false }))
    render(tree())
    expect(ctx.selectedSide).toBe('right')
    expect(ctx.isLinked).toBe(false)
    expect(localStorage.getItem('sleepypod-pre-single-sleeper-selection')).toBeNull()
    expect(localStorage.getItem('sleepypod-single-sleeper-side')).toBeNull()
  })

  it('is per-side when both sides are away', () => {
    state.sides = away(true, true)
    render(tree())
    expect(ctx.singleSleeperSide).toBeNull()
    expect(ctx.selectedSide).toBe('left')
  })
})
