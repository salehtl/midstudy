// The product page's SAX driver (server/src/product/html.ts): a self-closing <svg/> or <math/> leaves foreign content at
// once, so what follows it is read as HTML. parsePage directly; no wasm, no server.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePage, type Page } from '../src/product/html.ts'

const tick = (): Promise<void> => Promise.resolve()
const parse = (html: string): Promise<Page> => parsePage(html, 'https://shop.test/p', tick)
const scriptTexts = (page: Page): string[] => page.scripts.map((s) => s[1])

const JSON_IN_SCRIPT = 'var p={"size":"<b>200 x 90 cm</b>"}'

for (const tag of ['svg', 'math']) {
  void test(`<${tag}/> leaves foreign content: a following script stays raw text`, async () => {
    const page = await parse(`<html><body><${tag}/><script>${JSON_IN_SCRIPT}</script><p>after</p>`)
    assert.deepEqual(scriptTexts(page), [JSON_IN_SCRIPT])
    assert.deepEqual(page.lines, ['after'])
  })
}

void test('nested <svg><svg/></svg> enters twice and leaves twice', async () => {
  const page = await parse(`<svg><svg/></svg><script>${JSON_IN_SCRIPT}</script><p>after</p>`)
  assert.deepEqual(scriptTexts(page), [JSON_IN_SCRIPT])
  assert.deepEqual(page.lines, ['after'])
})

void test('<svg/> inside foreignObject returns to the HTML of the integration point', async () => {
  const page = await parse(`<svg><foreignObject><svg/><script>${JSON_IN_SCRIPT}</script></foreignObject></svg><p>after</p>`)
  assert.deepEqual(scriptTexts(page), [JSON_IN_SCRIPT])
  assert.deepEqual(page.lines, ['after'])
})

void test('parity: an open svg with a self-closing child closes as before', async () => {
  const page = await parse('<svg><path/></svg><script>a<b</script>')
  assert.deepEqual(scriptTexts(page), ['a<b'])
})

void test('parity: a title inside an svg is an svg title, not the page title, after a nested <svg/> too', async () => {
  const page = await parse('<svg><svg/><title>x</title></svg>')
  assert.equal(page.title, null)
  assert.deepEqual(page.lines, [])
})
