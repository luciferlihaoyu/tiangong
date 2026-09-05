import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * 消息提示（toast）固定浅色主题：
 * - 不再跟随站点深色主题 —— 此前 --normal-bg 传的是 shadcn 裸 HSL 分量
 *   （如 "240 23% 5%"，缺 hsl() 包裹），sonner 无法解析导致底色/字色双双
 *   回退继承，深色页面上表现为"黑底黑字完全看不清"。
 * - 浅色底 + 深色字对比度恒定，不受主题切换影响。
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "#ffffff",
          "--normal-text": "#1a1d29",
          "--normal-border": "rgba(15, 23, 42, 0.15)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
