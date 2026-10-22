import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandSettingsView } from '../src/screens/BrandSettings'

const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'

describe('brand settings', () => {
  it('shows name, status and shadow mode, and links to every other settings screen', () => {
    const html = renderToStaticMarkup(
      <BrandSettingsView
        brandId={brandId}
        brand={{
          id: brandId,
          name: 'Aztek Global',
          slug: 'aztek',
          status: 'active',
          shadowMode: true,
          role: 'platform_owner',
        }}
      />,
    )
    expect(html).toContain('Aztek Global')
    expect(html).toContain('Active')
    expect(html).toContain('Everything is made and approved as usual, and nothing is sent.')
    for (const area of ['users', 'safety', 'approvals', 'audit']) {
      expect(html).toContain(`href="/b/${brandId}/settings/${area}"`)
    }
    expect(html).not.toMatch(/\sstyle=/)
  })
})
