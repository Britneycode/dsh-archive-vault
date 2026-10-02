/**
 * 宿主基线模块的最小类型声明。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-slots`
 * 由桌面端 shell 通过 PLATFORM_MODULES 静态表提供，插件不打包也不安装它们：
 * 运行中的安装目录里没有它们的 .d.ts，npm 上的 0.2.0-rc.2 又依赖未公开的内部包
 * （@deepseek-ai/dsh-type-meta）装不下来。这里只声明插件真正用到的那部分 API，
 * 宿主改了签名就改这里，而不是去猜。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react'

  /** 桌面端按钮：变体 primary / ghost / outline / toolbar，尺寸 md 36px、sm 28px。 */
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  }
  export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>

  /** 不可逆操作的模态确认：勾选 acknowledgement 之后主按钮才可用。 */
  export interface RiskConfirmationProps {
    open: boolean
    title: ReactNode
    description: ReactNode
    acknowledgeLabel: ReactNode
    cancelLabel: ReactNode
    closeLabel: ReactNode
    confirmLabel: ReactNode
    acknowledged: boolean
    disabled?: boolean
    onAcknowledgedChange: (acknowledged: boolean) => void
    onCancel: () => void
    onConfirm: () => void
  }
  export function RiskConfirmation(props: RiskConfirmationProps): ReactNode

  /** 浮层提示（portal 到 document.body，到期自动淡出）。 */
  export interface ToastProps {
    text: ReactNode
    icon?: ReactNode
    tone?: 'success'
    anchor?: HTMLElement | null
    holdMs?: number
    actions?: Array<{ prefix?: ReactNode; label: ReactNode; onClick: () => void }>
    onDone: () => void
  }
  export function Toast(props: ToastProps): ReactNode

  /** 16px 线性图标，与桌面端同一套图标资源。 */
  export interface IconProps {
    size?: number
    className?: string
    color?: string
  }
  export function IconTrashOutlineRegular(props: IconProps): ReactNode
  export function IconRefreshOutlineRegular(props: IconProps): ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** 插件向父级声明的 slot 注册表（只用到 inject + register）。 */
  export interface SlotsService {
    inject: (slot: string, callback: () => void | (() => void)) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
}
