export interface Vector {
  name: string
  input: unknown
  // Present for a payload that must be accepted.
  canonical?: string
  hash?: string
  // Present for a payload that must be refused: a fragment of the reason.
  reject?: string
}

const BRAND = '00000000-0000-4000-8000-00000000000a'
const ITEM = '00000000-0000-4000-8000-0000000000c1'

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'content-version/1',
    brand_id: BRAND,
    content_item_id: ITEM,
    kind: 'summary',
    language: 'en',
    body: [{ type: 'paragraph', text: 'Hello' }],
    ...extra,
  }
}

const HEAD = `{"body":[{"text":"Hello","type":"paragraph"}],"brand_id":"${BRAND}","content_item_id":"${ITEM}",`

export const VECTORS: Vector[] = [
  {
    name: 'the smallest payload',
    input: base(),
    canonical: `${HEAD}"kind":"summary","language":"en","schema":"content-version/1"}`,
    hash: 'sha256:8c79d20009ee853afab34e73539e467675cdcba2db0c131ff4ae15047e2d359e',
  },
  {
    name: 'the same payload with its keys in another order gives the same text',
    input: {
      language: 'en',
      body: [{ text: 'Hello', type: 'paragraph' }],
      kind: 'summary',
      schema: 'content-version/1',
      content_item_id: ITEM,
      brand_id: BRAND,
    },
    canonical: `${HEAD}"kind":"summary","language":"en","schema":"content-version/1"}`,
    hash: 'sha256:8c79d20009ee853afab34e73539e467675cdcba2db0c131ff4ae15047e2d359e',
  },
  {
    name: 'accented text in the decomposed form is written in the composed form',
    // The input is "Cafe" followed by U+0301 (decomposed); the expected text has U+00E9 (composed).
    input: base({ title: 'Cafe\u0301' }),
    canonical: `${HEAD}"kind":"summary","language":"en","schema":"content-version/1","title":"Caf\u00e9"}`,
    hash: 'sha256:593cc8547c5c1bee396ab221fe07e4ec636dc3f62b221ae2e239d9d35865a285',
  },
  {
    name: 'mixed line endings inside the body become line feeds',
    input: base({ body: [{ type: 'paragraph', text: 'a\r\nb\rc' }] }),
    canonical: `{"body":[{"text":"a\\nb\\nc","type":"paragraph"}],"brand_id":"${BRAND}","content_item_id":"${ITEM}","kind":"summary","language":"en","schema":"content-version/1"}`,
    hash: 'sha256:08b38842d85e99d41d9b6bacb10e7774323c4faa40349d22171fea8d990febdd',
  },
  {
    name: 'an unordered list is sorted',
    input: base({ disclosures: ['b_flag', 'a_flag'] }),
    canonical: `${HEAD}"disclosures":["a_flag","b_flag"],"kind":"summary","language":"en","schema":"content-version/1"}`,
    hash: 'sha256:2ade3258d8fabeefc7a36857629d520455ea9c50594638b5059a8083a0e0e8a6',
  },
  {
    name: 'a link has its scheme and host in lower case and its default port removed, and keeps its path',
    input: base({ links: [{ url: 'HTTPS://Example.COM:443/Path?Q=1#F', role: 'source' }] }),
    canonical: `${HEAD}"kind":"summary","language":"en","links":[{"role":"source","url":"https://example.com/Path?Q=1#F"}],"schema":"content-version/1"}`,
    hash: 'sha256:0e879fde6468c1e226597a31b345429edb49910c9f9dcd426c207b0dc8bcfe3b',
  },
  {
    name: 'an invisible zero-width space is refused, not removed',
    input: base({ title: 'Hel\u200blo' }),
    reject: 'invisible',
  },
  {
    name: 'a duplicate in an unordered list is refused',
    input: base({ disclosures: ['a_flag', 'a_flag'] }),
    reject: 'duplicate',
  },
  {
    name: 'a plain http link is refused',
    input: base({ links: [{ url: 'http://example.com', role: 'source' }] }),
    reject: 'https',
  },
  {
    name: 'a link with a user name or password is refused',
    input: base({ links: [{ url: 'https://user:pw@example.com/', role: 'source' }] }),
    reject: 'user name',
  },
  {
    name: 'a backslash in a link is refused, not read as a slash',
    input: base({ links: [{ url: 'https://a.com\\path', role: 'source' }] }),
    reject: 'backslash',
  },
  {
    name: 'a line break in a single-line field is refused',
    input: base({ title: 'one\ntwo' }),
    reject: 'line break',
  },
  { name: 'an unpaired surrogate is refused', input: base({ title: 'bad\ud800' }), reject: 'surrogate' },
]
