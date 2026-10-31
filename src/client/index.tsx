/**
 * dsh-archive-vault — 设置页「归档清理」面板（桌面端）。
 *
 * 与 dsh 桌面端 UI 保持一致的做法：
 *
 *  1. 控件全部来自宿主自带的基线模块 `@deepseek-ai/dsh-client-ui-primitives`
 *     （shell 的 PLATFORM_MODULES 静态表，见 @deepseek-ai/dsh-client-modules
 *     README「Sharing modules」）。桌面端设置页用的就是同一批组件，因此桌面端
 *     改版时本面板随宿主一起变，插件侧不需要同步任何组件样式；
 *  2. 排版沿用桌面端设置页的标尺：页标题 16/24 medium、行标题 14/20、
 *     行说明 12/18 label-secondary、行分隔 0.5px border-l2、行内边距 16px 0；
 *  3. 颜色只走 `--dsw-*` 语义令牌（含 error/success 状态色），跟随桌面端
 *     亮色/暗色主题切换；
 *  4. 永久删除这类不可逆操作走桌面端的 `RiskConfirmation`（模态 + 勾选确认），
 *     不再自造红色按钮和 5 秒二次点击。
 *
 * 面板只做宿主明确不提供的「永久删除」；浏览与恢复归档会话由桌面端左侧会话
 * 列表的「仅显示已归档」筛选和行菜单承担。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  RiskConfirmation,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

/** 浏览器侧插件上下文（桌面端与 web 端同一套客户端运行时）。 */
type ClientContext = {
  effect: (callback: () => void | (() => void), label?: string) => void
  slots: SlotsService
  sessions: { refresh: () => Promise<void> }
}

export const inject = ['sessions', 'slots']

const API = '/archive-vault/api'
const PLUGIN_ID = 'dsh-archive-vault'

/** 面板样式：只在宿主文档里挂一次，跟随插件生命周期被 HMR 回收。 */
const css = `
.avd{display:flex;flex-direction:column;width:100%;color:var(--dsw-alias-label-primary)}
.avd-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.avd-desc{color:var(--dsw-alias-label-tertiary);margin:6px 0 0;font-size:12px;line-height:18px}
.avd-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.avd-head+.avd-row{margin-top:8px}
.avd-row:last-child{border-bottom:none}
.avd-row-text{min-width:0}
.avd-row-title{font-size:14px;line-height:20px}
.avd-row-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}
.avd-row-action{flex:none;display:flex;align-items:center;gap:8px}
.avd-status{margin:16px 0 0;padding:10px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;max-height:200px;overflow:auto}
.avd-status-error{color:var(--dsw-alias-label-error)}
`

function ensureStyle(): void {
  if (typeof document === 'undefined') return
  const tagId = `${PLUGIN_ID}/panel.css`
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}

interface Summary {
  count: number
  unknownCount: number
  eligible7Days: number
  eligible30Days: number
}

interface Failure {
  sessionId: string
  error: string
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

function reason(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

function createSection(sessions: ClientContext['sessions']): () => ReactNode {
  return function ArchiveVaultSection(): ReactNode {
    const [summary, setSummary] = useState<Summary | null>(null)
    const [busy, setBusy] = useState(false)
    const [detail, setDetail] = useState('')
    const [pending, setPending] = useState<7 | 30 | 'all' | null>(null)
    const [acknowledged, setAcknowledged] = useState(false)
    const [toast, setToast] = useState<{ key: number; text: string; tone?: 'success' } | null>(null)

    useEffect(() => { ensureStyle() }, [])

    const load = useCallback(async (): Promise<void> => {
      const data = await fetchJson('/summary')
      if (!data?.ok) throw new Error(data?.error || '归档状态读取失败')
      const cleanup = data?.cleanup ?? {}
      setSummary({
        count: Number(data?.count ?? 0),
        unknownCount: Number(cleanup.unknownCount ?? 0),
        eligible7Days: Number(cleanup.eligible7Days ?? 0),
        eligible30Days: Number(cleanup.eligible30Days ?? 0),
      })
    }, [])

    const refresh = useCallback((): void => {
      setBusy(true)
      void load()
        .then(() => { setDetail('') })
        .catch((error: unknown) => { setDetail(`归档状态读取失败：${reason(error)}`) })
        .finally(() => { setBusy(false) })
    }, [load])

    useEffect(() => { refresh() }, [refresh])

    const confirm = useCallback((scope: 7 | 30 | 'all'): void => { void (async (): Promise<void> => {
      setPending(null)
      setAcknowledged(false)
      setBusy(true)
      try {
        const data = await fetchJson('/cleanup', { method: 'POST', body: JSON.stringify({ days: scope }) })
        if (!data?.ok) throw new Error(data?.error || '批量清理失败')
        const deleted = Number(data?.deletedCount ?? 0)
        const failures: Failure[] = Array.isArray(data?.failures) ? data.failures : []
        const sessionError = await sessions.refresh().then(() => null, (error: unknown) => error)
        const summaryError = await load().then(() => null, (error: unknown) => error)
        if (failures.length > 0) {
          setDetail(failures.map(row => `${row.sessionId}：${row.error}`).join('\n'))
          setToast({ key: Date.now(), text: `已永久删除 ${deleted} 个，失败 ${failures.length} 个` })
        } else if (sessionError !== null || summaryError !== null) {
          setDetail(reason(sessionError ?? summaryError))
          setToast({ key: Date.now(), text: `已永久删除 ${deleted} 个，但界面刷新失败；请刷新页面` })
        } else {
          setDetail('')
          setToast({
            key: Date.now(),
            text: scope === 'all'
              ? `已永久删除全部 ${deleted} 个归档对话`
              : `已永久删除 ${deleted} 个归档超过 ${scope} 天的对话`,
            tone: 'success',
          })
        }
      } catch (error) {
        setDetail(`批量清理失败：${reason(error)}`)
        setToast({ key: Date.now(), text: '批量清理失败' })
      } finally {
        setBusy(false)
      }
    })() }, [load, sessions])

    const count = (days: 7 | 30): number => (days === 7 ? summary?.eligible7Days : summary?.eligible30Days) ?? 0

    const summaryText = summary === null
      ? '正在读取归档状态…'
      : summary.count === 0
        ? '没有归档的会话'
        : `共 ${summary.count} 个归档会话${summary.unknownCount > 0 ? ` · ${summary.unknownCount} 个归档时间未知` : ''}`

    const cleanupRows = ([7, 30, 'all'] as const).map((scope) => {
      const total = scope === 'all' ? summary?.count ?? 0 : count(scope)
      const unknown = summary?.unknownCount ?? 0
      const title = scope === 'all' ? '清理全部归档' : `清理 ${scope} 天以上`
      const desc = total === 0
        ? (scope === 'all' ? '没有归档的会话' : `没有归档满 ${scope} 天的会话`)
        : scope === 'all'
          ? `全部 ${total} 个归档会话${unknown > 0 ? `（含 ${unknown} 个归档时间未知）` : ''}，可永久删除`
          : `${total} 个会话已归档满 ${scope} 天，可永久删除`
      return (
        <div className="avd-row" key={scope}>
          <div className="avd-row-text">
            <div className="avd-row-title">{title}</div>
            <div className="avd-row-desc">{desc}</div>
          </div>
          <div className="avd-row-action">
            <Button
              variant="outline"
              icon={<IconTrashOutlineRegular size={16} />}
              disabled={busy || total === 0}
              onClick={() => { setAcknowledged(false); setPending(scope) }}
            >
              {total === 0 ? '删除' : scope === 'all' ? `全部删除 ${total} 个` : `删除 ${total} 个`}
            </Button>
          </div>
        </div>
      )
    })

    return (
      <section className="avd">
        <div className="avd-head">
          <h2 className="avd-title">归档清理</h2>
          <p className="avd-desc">
            永久删除归档会话：清除归档记录、工作区记账并删除磁盘上的会话日志，不可恢复。
            浏览与恢复请用左侧会话列表的「仅显示已归档」筛选。
          </p>
        </div>

        <div className="avd-row">
          <div className="avd-row-text">
            <div className="avd-row-title">归档会话</div>
            <div className="avd-row-desc">{summaryText}</div>
          </div>
          <div className="avd-row-action">
            <Button
              variant="outline"
              icon={<IconRefreshOutlineRegular size={16} />}
              disabled={busy}
              onClick={refresh}
            >
              刷新
            </Button>
          </div>
        </div>

        {cleanupRows}

        {detail === '' ? null : (
          <p className="avd-status avd-status-error" role="alert">{detail}</p>
        )}

        <RiskConfirmation
          open={pending !== null}
          title="永久删除归档会话"
          description={(pending === 'all'
            ? `将永久删除全部 ${summary?.count ?? 0} 个归档对话（含归档时间未知的历史归档）：`
            : `将永久删除 ${pending === null ? 0 : count(pending)} 个归档超过 ${pending ?? 0} 天的对话：`)
            + '清除归档记录、工作区记账，并删除磁盘上的会话日志。此操作不可恢复；正在运行的会话会被拒绝。'}
          acknowledgeLabel="我了解这些对话将无法恢复"
          cancelLabel="取消"
          closeLabel="关闭"
          confirmLabel="永久删除"
          acknowledged={acknowledged}
          disabled={busy}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setAcknowledged(false); setPending(null) }}
          onConfirm={() => { if (pending !== null) confirm(pending) }}
        />

        {toast === null ? null : (
          <Toast
            key={toast.key}
            text={toast.text}
            {...toast.tone === undefined ? {} : { tone: toast.tone }}
            onDone={() => { setToast(null) }}
          />
        )}
      </section>
    )
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      // ponytail: 借用桌面端设置 shell 已为该页预留的 id（settings-general 的
      // navIcon 只认 'archived-sessions'，其它 id 一律回落成齿轮图标）。宿主将来
      // 若自带同名设置页，两个 section 会同时挂在同一导航项下——那时本插件本就多余，
      // 到时删插件而不是改 id。
      id: 'archived-sessions',
      order: 61,
      label: () => '归档清理',
    }, createSection(ctx.sessions)),
  ), `${PLUGIN_ID}: panel`)
}
