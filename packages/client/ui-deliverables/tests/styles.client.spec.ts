import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/Deliverables.module.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const match = new RegExp(`\\${selector} \\{([^}]*)\\}`, 'u').exec(css)
  if (match === null) throw new Error(`Deliverables.module.css has no ${selector} rule`)
  return match[1] ?? ''
}

describe('Deliverables theme surface styles', () => {
  it('keeps the aligned upstream delivery-card radii and themed fills', () => {
    expect(rule('.file')).toContain('border-radius: 18px')
    expect(rule('.fileIcon')).toContain('border-radius: 10px')
    expect(rule('.fileIcon')).toContain('background: color-mix(in srgb, var(--dsw-static-neutral-00) 50%, transparent)')
    expect(rule('.root')).toContain('--deliverable-fill:')
    expect(css).toContain('[data-ds-dark-theme]')
  })
})
