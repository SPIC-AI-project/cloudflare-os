// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// base-ui's Checkbox/Switch synthesize a PointerEvent on activation; jsdom has no constructor.
vi.stubGlobal('PointerEvent', class extends MouseEvent {})
Element.prototype.scrollIntoView = () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof Kumo
  return { ...actual, useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }) }
})

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: null,
  }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }
})

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import Activity, { type ActivityView } from './Activity'
import { useActionReview } from './features/actions/useActionReview'

const testRoot = makeTestRoot()

type Server = ReturnType<typeof makeOverseer>

const Host = ({ server, view, paneOpen = true, reviewTarget }: {
  server: Server
  view: ActivityView
  paneOpen?: boolean
  reviewTarget?: { gatekeeperId?: number; request: number }
}) => {
  const review = useActionReview(server.overseer, {
    workspaceId: 'ws',
    active: paneOpen && view === 'review',
    connected: true,
  })
  return paneOpen
    ? (
      <Activity
        overseer={server.overseer}
        view={view}
        onViewChange={() => {}}
        review={review}
        reviewTarget={reviewTarget}
      />
    )
    : null
}

/** A tagged action a rule could apply, on connection 1. */
const editKind: ActionKind = { tag: 'edit', label: 'Edits' }
const eligible = {
  gatekeeperId: 1,
  description: {
    title: 'Action 50',
    description: '',
    implementsRevert: false,
    actionKind: editKind,
    autoApprovable: true,
  },
}

function withAutoApproval(server: Server) {
  const rules: Array<{ gatekeeperId: number; actionKind: ActionKind }> = []
  const setAutoApprovedActionKind =
    vi.fn<(gatekeeperId: number, actionKind: ActionKind) => Promise<void>>(
      async (gatekeeperId, actionKind) => { rules.push({ gatekeeperId, actionKind }) })
  const removeAutoApprovedActionKind =
    vi.fn<(gatekeeperId: number, tag: string) => Promise<void>>(async (gatekeeperId, tag) => {
      const index = rules.findIndex(r =>
        r.gatekeeperId === gatekeeperId && r.actionKind.tag === tag)
      if (index >= 0) rules.splice(index, 1)
    })
  Object.assign(server.overseer as object, {
    listPreApprovableActions: async () => [],
    listAutoApprovedActionKinds: async () => [...rules],
    setAutoApprovedActionKind,
    removeAutoApprovedActionKind,
  })
  return { rules, setAutoApprovedActionKind, removeAutoApprovedActionKind }
}

/** Connection 1 waiting on 10/30/50, reviewed and settled. */
async function openReview(records = [entry(50, eligible), entry(30, { gatekeeperId: 1 }), entry(10, { gatekeeperId: 1 })]) {
  const server = makeOverseer()
  withAutoApproval(server)
  await testRoot.render(<Host server={server} view="review" />)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: records })
  flushFrames()
  return server
}

const veto = (title: string) =>
  document.querySelector<HTMLElement>(`[role="checkbox"][aria-label^="Veto ${title} on "]`)

const control = (label: string) =>
  [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)

const ruleSwitch = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

describe('Activity review', () => {
  it('stages a veto locally and applies the whole connection once', async () => {
    const server = await openReview()

    expect(document.body.textContent).toContain('3 actions to apply')

    await act(async () => veto('Action 30')!.click())

    expect(document.body.textContent).toContain('2 actions to apply · 1 veto')
    expect(veto('Action 30')!.getAttribute('aria-checked')).toBe('true')
    expect(server.applyCalls).toEqual([])

    await act(async () => control('Apply batch')!.click())

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [30] }])
    expect(control('Applying…')).toBeDefined()
  })

  it('keeps a stopped action reviewable with its reason and a way past it', async () => {
    await openReview([
      entry(50, eligible),
      entry(30, { gatekeeperId: 1, failure: 'Resource changed upstream' }),
    ])

    expect(document.body.textContent).toContain('Resource changed upstream')
    expect(document.body.textContent).toContain(
      'Select Veto to skip it, or apply again to retry.')
    expect(veto('Action 30')!.getAttribute('disabled')).toBeNull()
  })

  it('holds arrivals out of the batch until they are explicitly included', async () => {
    const server = await openReview()
    await server.emit(entry(70, { gatekeeperId: 1 }))
    flushFrames()

    expect(document.body.textContent).toContain('1 new action')
    expect(document.body.textContent).toContain('3 actions to apply')

    await act(async () => control('Include')!.click())

    expect(document.body.textContent).toContain('4 actions to apply')
    expect(server.applyCalls).toEqual([])

    await act(async () => control('Apply batch')!.click())

    expect(server.applyCalls).toEqual([{ id: 70, vetoes: [] }])
  })

  it('retains veto selections while the pane is closed', async () => {
    const server = await openReview()
    await act(async () => veto('Action 30')!.click())

    await testRoot.render(<Host server={server} view="review" paneOpen={false} />)
    await testRoot.render(<Host server={server} view="review" />)

    expect(document.body.textContent).toContain('2 actions to apply · 1 veto')
  })

  it('does not steal focus when a later arrival follows an empty reveal', async () => {
    const server = makeOverseer()
    withAutoApproval(server)
    await testRoot.render(
      <Host server={server} view="review" reviewTarget={{ gatekeeperId: 1, request: 1 }} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    flushFrames()

    // The reviewer went back to what they were doing; the request is spent either way.
    const elsewhere = document.body.appendChild(document.createElement('button'))
    elsewhere.focus()
    await server.emit(entry(10, { gatekeeperId: 1 }))
    flushFrames()

    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})

describe('Activity auto-approval', () => {
  it('offers a rule for a type only a pending action advertises', async () => {
    const server = await openReview()
    const auto = withAutoApproval(server)
    await testRoot.render(<Host server={server} view="auto" />)
    await vi.waitFor(() => expect(ruleSwitch('Enable auto-approval for Edits')).not.toBeNull())

    await act(async () => ruleSwitch('Enable auto-approval for Edits')!.click())

    expect(auto.setAutoApprovedActionKind).toHaveBeenCalledWith(1, editKind)
  })

  it('will not grant a rule over a connection the user is still reviewing', async () => {
    const server = await openReview()
    const auto = withAutoApproval(server)
    await act(async () => veto('Action 30')!.click())

    await testRoot.render(<Host server={server} view="auto" />)
    await vi.waitFor(() => expect(ruleSwitch('Enable auto-approval for Edits')).not.toBeNull())
    await act(async () => ruleSwitch('Enable auto-approval for Edits')!.click())

    expect(auto.setAutoApprovedActionKind).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'Apply this connection’s batch or clear its veto selections before enabling auto-approval.')
  })

  it('still revokes an enabled rule on a connection with staged vetoes', async () => {
    const server = await openReview()
    const auto = withAutoApproval(server)
    auto.rules.push({ gatekeeperId: 1, actionKind: editKind })
    await act(async () => veto('Action 30')!.click())

    await testRoot.render(<Host server={server} view="auto" />)
    await vi.waitFor(() => expect(ruleSwitch('Disable auto-approval for Edits')).not.toBeNull())
    await act(async () => ruleSwitch('Disable auto-approval for Edits')!.click())

    expect(auto.removeAutoApprovedActionKind).toHaveBeenCalledWith(1, 'edit')
  })
})
