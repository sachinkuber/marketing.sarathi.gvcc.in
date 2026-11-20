import { describe, expect, it } from 'vitest'
import { extractJsonObject, ReplyHasNoJson } from '../src/json-reply.ts'

const result = {
  group: 'site',
  sources: [{ ref: 's1', extract: 'Braces {in} a "quoted" string } stay text.' }],
  findings: [],
  unsettled: [],
}
const json = JSON.stringify(result)

describe('extractJsonObject', () => {
  it('reads a clean object', () => {
    expect(extractJsonObject(json)).toEqual(result)
    expect(extractJsonObject(`\n  ${JSON.stringify(result, null, 2)}\n`)).toEqual(result)
  })

  it('reads the object after narration', () => {
    expect(
      extractJsonObject(`I searched the site and read four pages. Here is the result:\n${json}`),
    ).toEqual(result)
  })

  it('reads the object before narration, and inside a code fence', () => {
    expect(extractJsonObject(`${json}\n\nThat covers every key I could settle.`)).toEqual(result)
    expect(extractJsonObject('```json\n' + json + '\n```')).toEqual(result)
  })

  it('reads an object split across joined text blocks, past stray braces and a smaller object', () => {
    const blocks = ['Checked {the menu', ' and {"a": 1} too. ', json.slice(0, 40), json.slice(40)]
    expect(extractJsonObject(blocks.join(''))).toEqual(result)
  })

  it('refuses text with no object, without quoting it', () => {
    for (const text of ['', 'No result today.', '[1, 2]', '{"group": "site", "sources": [', '{not json}']) {
      expect(() => extractJsonObject(text)).toThrow(ReplyHasNoJson)
    }
    expect(() => extractJsonObject('secret page text')).toThrow('The reply holds no JSON object.')
  })
})
