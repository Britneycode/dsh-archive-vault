/**
 * dsh-archive-vault 设置页面板：归档清理。
 *
 * 浏览、搜索与恢复归档会话由 dsh 内置设置页（Archived sessions）承担；
 * 本面板只做宿主明确不提供的永久删除：按实际归档时长批量清理（同源
 * API /archive-vault/api 的 summary + cleanup）。要永久删除单个会话，
 * 可让 agent 调用 delete_archived_session 工具。
 * React 组件只负责面板挂载，界面使用原生 DOM（与更新中心面板同一模式，
 * 避免把宿主的 React 运行时打进插件 bundle）。
 */
import { createElement, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanupButtonLabel } from '../client-sync.js'

type ClientContext = {
  slots: SlotsService
  sessions: {
    refresh: () => Promise<void>
  }
}

export const inject = ['sessions', 'slots']

const API = '/archive-vault/api'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (cls) element.className = cls
  if (text !== void 0) element.textContent = text
  return element
}

const styles = `
.av-page{font-family:inherit;font-size:13px;line-height:1.5;width:min(100%,860px);min-width:0;overflow:hidden;padding:8px 4px 24px;color:var(--dsw-alias-label-primary)}
.av-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.av-toolbar h2{font-size:16px;line-height:1.3;margin:0;letter-spacing:0}
.av-summary{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px}
.av-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.av-btn{min-height:32px;border:1px solid transparent;border-radius:6px;padding:6px 12px;background:#2878d0;color:#fff;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.av-btn.secondary{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.av-btn.danger{background:transparent;border-color:rgba(210,58,58,.45);color:#d23a3a}
.av-btn.danger.armed{background:#d23a3a;border-color:#d23a3a;color:#fff}
.av-btn.cleanup{min-width:148px}
.av-btn:disabled{opacity:.45;cursor:not-allowed}
.av-hint{margin-top:14px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.av-msg{margin-top:14px;padding:10px 12px;border-left:3px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;max-height:220px;overflow:auto;font-size:12px}
.av-msg.ok{border-color:#28945a}
.av-msg.err{border-color:#d23a3a}
@media(max-width:680px){
  .av-toolbar{align-items:flex-start;flex-direction:column}
  .av-actions{justify-content:flex-start;width:100%}
  .av-btn{max-width:100%;white-space:normal}
  .av-btn.cleanup{width:100%;min-width:0;min-height:48px}
}
`

interface CleanupSummaryView {
  trackedCount: number
  unknownCount: number
  eligible7Days: number
  eligible30Days: number
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}

function buildPanel(sessions: ClientContext['sessions']): HTMLElement {
  const style = el('style')
  style.textContent = styles

  const page = el('div', 'av-page')
  page.append(style)

  const toolbar = el('div', 'av-toolbar')
  const heading = el('div')
  heading.append(el('h2', undefined, '归档清理'))
  const summary = el('div', 'av-summary', '正在读取归档状态…')
  heading.append(summary)
  const refreshButton = el('button', 'av-btn secondary', '刷新')
  refreshButton.type = 'button'
  const cleanup7Button = el('button', 'av-btn danger cleanup', cleanupButtonLabel(7, 0, 'idle'))
  cleanup7Button.type = 'button'
  cleanup7Button.disabled = true
  const cleanup30Button = el('button', 'av-btn danger cleanup', cleanupButtonLabel(30, 0, 'idle'))
  cleanup30Button.type = 'button'
  cleanup30Button.disabled = true
  const actions = el('div', 'av-actions')
  actions.append(refreshButton, cleanup7Button, cleanup30Button)
  toolbar.append(heading, actions)
  page.append(toolbar)

  page.append(el('div', 'av-hint', '浏览与恢复归档会话请使用内置「Archived sessions」设置页；永久删除单个会话可让 agent 调用 delete_archived_session 工具。'))

  const message = el('div', 'av-msg')
  message.style.display = 'none'
  page.append(message)

  let total = 0
  let cleanup: CleanupSummaryView = {
    trackedCount: 0,
    unknownCount: 0,
    eligible7Days: 0,
    eligible30Days: 0,
  }
  let busy = false
  let armedCleanup: 7 | 30 | null = null
  let cleanupTimer = 0

  function say(text: string, kind: 'ok' | 'err'): void {
    if (text === '') {
      message.style.display = 'none'
      return
    }
    message.className = `av-msg ${kind}`
    message.textContent = text
    message.style.display = 'block'
  }

  function setBusy(on: boolean): void {
    busy = on
    refreshButton.disabled = on
    renderCleanupButtons()
  }

  function cleanupCount(days: 7 | 30): number {
    return days === 7 ? cleanup.eligible7Days : cleanup.eligible30Days
  }

  function renderCleanupButtons(): void {
    for (const [days, button] of [[7, cleanup7Button], [30, cleanup30Button]] as const) {
      const count = cleanupCount(days)
      const state = busy ? 'busy' : armedCleanup === days ? 'armed' : 'idle'
      button.textContent = cleanupButtonLabel(days, count, state)
      button.disabled = busy || count === 0
      button.classList.toggle('armed', armedCleanup === days && !busy)
    }
  }

  function disarmCleanup(): void {
    window.clearTimeout(cleanupTimer)
    armedCleanup = null
    renderCleanupButtons()
  }

  function renderSummary(): void {
    const unknownSuffix = cleanup.unknownCount > 0 ? ` · ${cleanup.unknownCount} 个归档时间未知` : ''
    summary.textContent = total === 0
      ? '没有归档的会话'
      : `共 ${total} 个归档会话${unknownSuffix}`
    renderCleanupButtons()
  }

  function bindCleanup(button: HTMLButtonElement, days: 7 | 30): void {
    button.addEventListener('click', () => {
      if (busy) return
      const count = cleanupCount(days)
      if (count === 0) return
      if (armedCleanup !== days) {
        disarmCleanup()
        armedCleanup = days
        renderCleanupButtons()
        cleanupTimer = window.setTimeout(disarmCleanup, 5000)
        return
      }

      window.clearTimeout(cleanupTimer)
      armedCleanup = null
      setBusy(true)
      fetchJson('/cleanup', { method: 'POST', body: JSON.stringify({ days }) })
        .then(async (data: any) => {
          if (!data?.ok) throw new Error(data?.error || '批量清理失败')
          const deletedCount = Number(data?.deletedCount ?? 0)
          const failedCount = Number(data?.failedCount ?? 0)
          const sessionRefreshError = await sessions.refresh().then(() => null, (error: unknown) => error)
          const summaryRefreshError = await loadSummary().then(() => null, (error: unknown) => error)
          if (failedCount > 0) {
            const details = Array.isArray(data?.failures)
              ? data.failures.map((failure: any) => `${String(failure.sessionId)}：${String(failure.error)}`).join('\n')
              : ''
            say(`已删除 ${deletedCount} 个，失败 ${failedCount} 个。${details === '' ? '' : `\n${details}`}`, 'err')
          } else if (sessionRefreshError !== null || summaryRefreshError !== null) {
            const reason = sessionRefreshError ?? summaryRefreshError
            const detail = reason instanceof Error ? reason.message : String(reason)
            say(`已删除 ${deletedCount} 个，但界面刷新失败；请刷新页面。\n${detail}`, 'err')
          } else {
            say(`已永久删除 ${deletedCount} 个归档超过 ${days} 天的对话。`, 'ok')
          }
        })
        .catch((error: unknown) => {
          say('批量清理失败：' + String(error instanceof Error ? error.message : error), 'err')
        })
        .finally(() => setBusy(false))
    })
  }

  function loadSummary(): Promise<void> {
    return fetchJson('/summary').then((data: any) => {
      if (!data?.ok) throw new Error(data?.error || '归档状态读取失败')
      total = Number(data?.count ?? 0)
      cleanup = data?.cleanup ?? cleanup
      renderSummary()
    })
  }

  function refresh(): Promise<void> {
    setBusy(true)
    return loadSummary()
      .then(() => {
        if (message.className.endsWith('err')) say('', 'ok')
      })
      .catch((error: unknown) => {
        summary.textContent = '归档状态读取失败'
        say('归档状态读取失败：' + String(error instanceof Error ? error.message : error), 'err')
      })
      .finally(() => setBusy(false))
  }

  refreshButton.addEventListener('click', () => { void refresh() })
  bindCleanup(cleanup7Button, 7)
  bindCleanup(cleanup30Button, 30)

  void refresh()
  return page
}

function createArchiveVaultPanel(sessions: ClientContext['sessions']): () => ReactNode {
  return function ArchiveVaultPanel(): ReactNode {
    const hostRef = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const panel = buildPanel(sessions)
      host.appendChild(panel)
      return () => { panel.remove() }
    }, [])
    return createElement('div', { ref: hostRef })
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'archive-vault',
      order: 61,
      label: () => '归档清理',
    }, createArchiveVaultPanel(ctx.sessions)),
  ), 'dsh-archive-vault: panel')
}
