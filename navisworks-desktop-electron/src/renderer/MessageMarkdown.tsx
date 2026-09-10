import type { ReactNode } from 'react'
function renderInlineMarkdown(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g)
  if (parts.length === 1) return text
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    return part
  })
}


/** Pipe tables are recognized only with a valid header separator, never inside code fences. */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

export function MessageMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let plain: string[] = []
  let fence = ''
  const flush = () => { if (plain.length) { blocks.push(<span key={blocks.length}>{renderInlineMarkdown(plain.join('\n'))}</span>); plain = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const marker = line.trim().match(/^(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]!
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = ''
      plain.push(line)
      continue
    }
    const header = cells(line)
    const separator = cells(lines[i + 1] ?? '')
    if (!fence && line.includes('|') && separator.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flush()
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|') && !/^\s*(`{3,}|~{3,})/.test(lines[i]!)) rows.push(cells(lines[i++]!))
      i--
      const align = separator.map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left') as Array<'left' | 'right' | 'center'>
      blocks.push(<div className="message-table-scroll" key={blocks.length} tabIndex={0} role="region" aria-label="回复表格"><table><thead><tr>{header.map((cell, n) => <th key={n} scope="col" style={{ textAlign: align[n] }}>{renderInlineMarkdown(cell)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, n) => <td key={n} style={{ textAlign: align[n] }}>{renderInlineMarkdown(row[n] ?? '')}</td>)}</tr>)}</tbody></table></div>)
    } else plain.push(line)
  }
  flush()
  return <>{blocks}</>
}
