import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { MessageMarkdown } from '../MessageMarkdown'

describe('reply tables', () => {
  const render = (text: string) => renderToStaticMarkup(<MessageMarkdown text={text} />)
  it('renders columns, alignment, and inline formatting safely', () => {
    const html = render('结果\n| 项目 | 数量 |\n| --- | ---: |\n| **风管** | 12 |\n| <script> | 4 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<strong>风管</strong>')
    expect(html).toContain('text-align:right')
    expect(html).toContain('&lt;script&gt;')
  })
  it('keeps ordinary pipes and fenced examples as text', () => {
    expect(render('a | b\nnot a separator')).not.toContain('<table>')
    expect(render('```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```')).not.toContain('<table>')
  })
  it('handles escaped pipes and incomplete streaming rows', () => {
    const html = render('| a | b |\n| --- | --- |\n| x\\|y |')
    expect(html).toContain('x|y')
    expect(html.match(/<td/g)).toHaveLength(2)
  })
})
