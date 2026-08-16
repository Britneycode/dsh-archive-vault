/**
 * dsh-archive-vault 设置页面板：归档对话。
 *
 * 同源 API（/archive-vault/api）提供列表、恢复、删除和按归档时长清理；
 * React 组件只负责面板挂载，界面使用原生 DOM（与更新中心面板同一模式，
 * 避免把宿主的 React 运行时打进插件 bundle）。
 */
import { createElement, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import {
  cleanupButtonLabel,
  reconcileDeletedSession,
  reconcileDeletedSessions,
} from '../client-sync.js'

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
.av-filter{display:flex;gap:8px;align-items:center;padding:14px 0 4px}
.av-input{flex:1 1 200px;min-width:160px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 10px}
.av-list{list-style:none;margin:0;padding:0}
.av-item{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:16px;align-items:center;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.av-item>*{min-width:0}
.av-item:first-child{border-top:0}
.av-preview{font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.av-preview.muted{color:var(--dsw-alias-label-tertiary);font-weight:400}
.av-meta{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px;flex-wrap:wrap;min-width:0}
.av-tag{display:inline-flex;align-items:center;min-height:20px;border-radius:4px;padding:1px 7px;font-size:10px;line-height:1.4;white-space:nowrap;background:var(--dsw-alias-bg-multi-select);color:var(--dsw-alias-label-secondary)}
.av-path{display:block;min-width:0;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.av-item-actions{display:flex;gap:8px;justify-content:flex-end}
.av-empty{padding:14px 0;color:var(--dsw-alias-label-tertiary)}
.av-msg{margin-top:14px;padding:10px 12px;border-left:3px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;max-height:220px;overflow:auto;font-size:12px}
.av-msg.ok{border-color:#28945a}
.av-msg.err{border-color:#d23a3a}
@media(max-width:680px){
  .av-toolbar{align-items:flex-start;flex-direction:column}
  .av-actions{justify-content:flex-start;width:100%}
  .av-btn{max-width:100%;white-space:normal}
  .av-btn.cleanup{width:100%;min-width:0;min-height:48px}
  .av-filter{width:100%}
  .av-input{min-width:0;width:100%}
  .av-item{grid-template-columns:1fr}
  .av-item-actions{justify-content:flex-start}
  .av-path{width:100%;max-width:100%}
}
`

interface ArchiveRowView {
  sessionId: string
  createdAt: number
  cwd: string | null
  workspaceTitle: string | null
  workspacePath: string | null
  blank: boolean
  preview: string
  previewAvailable: boolean
  archivedAt: number | null
}

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

function formatTime(createdAt: number): string {
  if (!createdAt) return '时间未知'
  try {
    return new Date(createdAt).toLocaleString()
  } catch {
    return '时间未知'
  }
}

function previewText(row: ArchiveRowView): string {
  if (row.blank) return '（空白会话）'
  if (row.preview) return row.preview
  return row.previewAvailable ? '（无文本提问）' : '（预览不可用）'
}

function archivedAgeText(archivedAt: number | null | undefined): string | null {
  if (typeof archivedAt !== 'number' || !Number.isFinite(archivedAt)) return null
  const days = Math.max(0, Math.floor((Date.now() - archivedAt) / (24 * 60 * 60 * 1_000)))
  return `已归档 ${days} 天`
}

function buildPanel(sessions: ClientContext['sessions']): HTMLElement {
  const style = el('style')
  style.textContent = styles

  const page = el('div', 'av-page')
  page.append(style)

  const toolbar = el('div', 'av-toolbar')
  const heading = el('div')
  heading.append(el('h2', undefined, '归档对话'))
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

  const filter = el('div', 'av-filter')
  const searchInput = el('input', 'av-input')
  searchInput.type = 'search'
  searchInput.placeholder = '搜索提问预览 / 工作区 / 路径 / 会话 id'
  filter.append(searchInput)
  page.append(filter)

  const listView = el('ul', 'av-list')
  page.append(listView)

  const message = el('div', 'av-msg')
  message.style.display = 'none'
  page.append(message)

  let rows: ArchiveRowView[] = []
  let cleanup: CleanupSummaryView = {
    trackedCount: 0,
    unknownCount: 0,
    eligible7Days: 0,
    eligible30Days: 0,
  }
  let query = ''
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

  function renderList(): void {
    listView.replaceChildren()
    const needle = query.trim().toLowerCase()
    const visible = needle === ''
      ? rows
      : rows.filter(row =>
        previewText(row).toLowerCase().includes(needle)
        || (row.workspaceTitle ?? '').toLowerCase().includes(needle)
        || (row.workspacePath ?? '').toLowerCase().includes(needle)
        || (row.cwd ?? '').toLowerCase().includes(needle)
        || row.sessionId.toLowerCase().includes(needle))
    const unknownSuffix = cleanup.unknownCount > 0 ? ` · ${cleanup.unknownCount} 个归档时间未知` : ''
    summary.textContent = rows.length === 0
      ? '没有归档的会话'
      : `共 ${rows.length} 个归档会话${needle !== '' ? `，匹配 ${visible.length} 个` : ''}${unknownSuffix} · 恢复后会话自动回到原位置`
    renderCleanupButtons()
    if (rows.length === 0) {
      const empty = el('li', 'av-empty', '没有归档的会话。归档入口在每个会话的右键菜单里。')
      listView.append(empty)
      return
    }
    if (visible.length === 0) {
      listView.append(el('li', 'av-empty', '没有匹配的归档会话。'))
      return
    }
    for (const row of visible) {
      const item = el('li', 'av-item')

      const main = el('div')
      const preview = el('div', `av-preview${row.blank || !row.preview ? ' muted' : ''}`, previewText(row))
      main.append(preview)
      const meta = el('div', 'av-meta')
      meta.append(el('span', undefined, formatTime(row.createdAt)))
      if (row.workspaceTitle !== null) {
        const tag = el('span', 'av-tag', row.workspaceTitle)
        meta.append(tag)
      } else {
        meta.append(el('span', 'av-tag', '未分组'))
      }
      const archiveAge = archivedAgeText(row.archivedAt)
      if (archiveAge !== null) meta.append(el('span', 'av-tag', archiveAge))
      const pathText = row.workspacePath ?? row.cwd
      if (pathText) {
        const path = el('span', 'av-path', pathText)
        path.title = `${pathText}\n${row.sessionId}`
        meta.append(path)
      }
      const idHint = el('span', undefined, `…${row.sessionId.slice(-8)}`)
      idHint.title = row.sessionId
      meta.append(idHint)
      main.append(meta)
      item.append(main)

      const itemActions = el('div', 'av-item-actions')
      const restoreButton = el('button', 'av-btn', '恢复')
      restoreButton.type = 'button'
      restoreButton.addEventListener('click', () => {
        if (busy) return
        setBusy(true)
        restoreButton.disabled = true
        restoreButton.textContent = '恢复中…'
        const label = previewText(row)
        fetchJson('/unarchive', { method: 'POST', body: JSON.stringify({ sessionId: row.sessionId }) })
          .then((data: any) => {
            if (!data?.ok) throw new Error(data?.error || '恢复失败')
            say(`已恢复「${label}」，会话已回到左侧列表原位置。`, 'ok')
            rows = rows.filter(candidate => candidate.sessionId !== row.sessionId)
            renderList()
          })
          .catch((error: unknown) => {
            say('恢复失败：' + String(error instanceof Error ? error.message : error), 'err')
            restoreButton.disabled = false
            restoreButton.textContent = '恢复'
          })
          .finally(() => setBusy(false))
      })
      itemActions.append(restoreButton)

      const deleteButton = el('button', 'av-btn danger', '删除')
      deleteButton.type = 'button'
      let armed = false
      let disarmTimer = 0
      const disarm = (): void => {
        armed = false
        deleteButton.classList.remove('armed')
        deleteButton.textContent = '删除'
      }
      deleteButton.addEventListener('click', () => {
        if (busy) return
        if (!armed) {
          armed = true
          deleteButton.classList.add('armed')
          deleteButton.textContent = '确认删除（不可恢复）'
          window.clearTimeout(disarmTimer)
          disarmTimer = window.setTimeout(disarm, 5000)
          return
        }
        window.clearTimeout(disarmTimer)
        setBusy(true)
        deleteButton.disabled = true
        deleteButton.textContent = '删除中…'
        const label = previewText(row)
        fetchJson('/delete', { method: 'POST', body: JSON.stringify({ sessionId: row.sessionId }) })
          .then(async (data: any) => {
            if (!data?.ok) throw new Error(data?.error || '删除失败')
            const refreshError = await reconcileDeletedSession(row.sessionId, {
              removeRow: (sessionId) => {
                rows = rows.filter(candidate => candidate.sessionId !== sessionId)
                renderList()
              },
              refreshSessions: () => sessions.refresh(),
            })
            if (refreshError === null) {
              const listError = await loadArchiveData().then(() => null, error => error)
              if (listError === null) {
                say(`已永久删除「${label}」及其会话日志。`, 'ok')
              } else {
                const detail = listError instanceof Error ? listError.message : String(listError)
                say(`已永久删除「${label}」，但归档列表刷新失败；请刷新页面。\n${detail}`, 'err')
              }
            } else {
              const detail = refreshError instanceof Error ? refreshError.message : String(refreshError)
              say(`已永久删除「${label}」，但左侧会话列表刷新失败；请刷新页面。\n${detail}`, 'err')
            }
          })
          .catch((error: unknown) => {
            say('删除失败：' + String(error instanceof Error ? error.message : error), 'err')
            disarm()
            deleteButton.disabled = false
          })
          .finally(() => setBusy(false))
      })
      itemActions.append(deleteButton)
      item.append(itemActions)

      listView.append(item)
    }
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
          const deletedIds = Array.isArray(data?.deletedSessionIds)
            ? data.deletedSessionIds.map(String)
            : []
          const sessionRefreshError = await reconcileDeletedSessions(deletedIds, {
            removeRows: (sessionIds) => {
              const removed = new Set(sessionIds)
              rows = rows.filter(candidate => !removed.has(candidate.sessionId))
              renderList()
            },
            refreshSessions: () => sessions.refresh(),
          })
          const listRefreshError = await loadArchiveData().then(() => null, error => error)
          const failedCount = Number(data?.failedCount ?? 0)
          if (failedCount > 0) {
            const details = Array.isArray(data?.failures)
              ? data.failures.map((failure: any) => `${String(failure.sessionId)}：${String(failure.error)}`).join('\n')
              : ''
            say(`已删除 ${deletedIds.length} 个，失败 ${failedCount} 个。${details === '' ? '' : `\n${details}`}`, 'err')
          } else if (sessionRefreshError !== null || listRefreshError !== null) {
            const reason = sessionRefreshError ?? listRefreshError
            const detail = reason instanceof Error ? reason.message : String(reason)
            say(`已删除 ${deletedIds.length} 个，但列表刷新失败；请刷新页面。\n${detail}`, 'err')
          } else {
            say(`已永久删除 ${deletedIds.length} 个归档超过 ${days} 天的对话。`, 'ok')
          }
        })
        .catch((error: unknown) => {
          say('批量清理失败：' + String(error instanceof Error ? error.message : error), 'err')
        })
        .finally(() => setBusy(false))
    })
  }

  function loadArchiveData(): Promise<void> {
    return fetchJson('/list').then((data: any) => {
      if (!data?.ok) throw new Error(data?.error || '归档状态读取失败')
      rows = Array.isArray(data?.sessions) ? data.sessions : []
      cleanup = data?.cleanup ?? cleanup
      renderList()
    })
  }

  function refresh(): Promise<void> {
    setBusy(true)
    return loadArchiveData()
      .then(() => {
        if (message.className.endsWith('err')) say('', 'ok')
      })
      .catch((error: unknown) => {
        summary.textContent = '归档状态读取失败'
        say('归档状态读取失败：' + String(error instanceof Error ? error.message : error), 'err')
      })
      .finally(() => setBusy(false))
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value
    renderList()
  })
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
      label: () => '归档对话',
    }, createArchiveVaultPanel(ctx.sessions)),
  ), 'dsh-archive-vault: panel')
}
