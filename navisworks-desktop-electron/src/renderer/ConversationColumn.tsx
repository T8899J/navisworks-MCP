import type { CSSProperties, PropsWithChildren } from 'react'

interface ConversationColumnProps extends PropsWithChildren {
  className?: string
  style?: CSSProperties
}

export function ConversationColumn({ children, className = '', style }: ConversationColumnProps) {
  return (
    <div className={`conversation-column ${className}`.trim()} style={style}>
      {children}
    </div>
  )
}
