import { describe, expect, it } from 'vitest'
import { registrableDomain } from '../src/screens/registrable-domain'

// The same cases as the core's test of the original (packages/shared registrableDomain, rulings R33, R34): this
// is a copy, so the two must not drift apart.
describe('registrableDomain (the dashboard copy)', () => {
  it.each([
    ['https://aztek.example/about', 'aztek.example'],
    ['https://www.aztek.example/', 'aztek.example'],
    ['https://shop.aztek.example/x', 'aztek.example'],
    ['https://aztek.co.in/', 'aztek.co.in'],
    ['https://www.shop.aztek.co.uk/', 'aztek.co.uk'],
    ['https://aztek.github.io/', 'aztek.github.io'],
    ['https://shop.notgithub.io/', 'notgithub.io'],
    ['https://Aztek.GitHub.IO/', 'aztek.github.io'],
    ['http://127.0.0.1/', '127.0.0.1'],
  ])('%s is %s', (address, domain) => {
    expect(registrableDomain(address)).toBe(domain)
  })

  it('is null for what is not a web address', () => {
    expect(registrableDomain(null)).toBeNull()
    expect(registrableDomain('brochure.pdf, pages 1–100')).toBeNull()
  })

  it('two tenants of a shared host are two domains', () => {
    expect(registrableDomain('https://aztek.github.io/')).not.toBe(
      registrableDomain('https://other.github.io/'),
    )
  })
})
