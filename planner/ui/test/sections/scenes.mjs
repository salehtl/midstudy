// planner-ui-scenes' checks (docs/notes/state-machines-plan.md): two uploads keep a card each and only the last opens;
// New room resumes by the step that failed, never making a second room; one New room at a time; a failed list keeps the
// poll going; a double Enter renames once; a confirm over a changed scene acts on nothing. Holds and 500s are page.route.
import fs from 'node:fs'
import path from 'node:path'

const PROBE = 'probe-box'
const PHOTO = fs.readFileSync(path.join(import.meta.dirname, '../../../../fixtures/scenes/living-wide/photo.jpg'))
const file = (name) => ({ name, mimeType: 'image/jpeg', buffer: PHOTO })
const TOASTS = () => [...document.querySelectorAll('#toasts .toast:not(.is-leaving)')].map((t) => t.textContent)
const openPage = (page) => page.evaluate(() => { window.midstudyCtx.shell.openPage('scenes') })
const closePage = (page) => page.evaluate(() => { window.midstudyCtx.shell.closePage() })
const shownScene = (page) => page.evaluate(() => { const e = window.midstudyCtx.engine; return e.getSceneLoad().name ?? e.getSceneName() })
const CARDS = '.sc-card.is-uploading:not(.rm-card):not([hidden])'
const NO = { status: 500, json: { error: { code: 'E', message: 'no' } } }

function hold() {
  let release = () => {}
  const gate = new Promise((r) => { release = r })
  return { gate, release }
}

export async function run({ ev, H, open, seedScene, srv }) {
  const { ensureScene, hook, sleep, waitFor, raw } = H
  const scene = await seedScene('living-wide', 'Scenes check')
  const other = await seedScene('room-1', 'Scenes other')
  const third = await seedScene('room-2', 'Scenes third')
  ev.check('scenes: three scenes of their own seeded', !!scene && !!other && !!third, `${scene} ${other} ${third}`)
  const holds = new Map() // upload file name -> a gate its POST waits on
  let failRoom = false
  let failAlign = false
  let renameGate = null
  let renames = 0
  let failList = 0
  let busyList = false
  let listGets = 0
  const setup = async (c) => {
    await c.route(/\/api\/scenes$/, async (route) => {
      if (route.request().method() === 'POST') await holds.get(route.request().headers()['x-midstudy-filename'])?.gate
      await route.continue()
    })
    await c.route(/\/api\/rooms$/, async (route) => {
      const m = route.request().method()
      if (m === 'POST' && failRoom) { await route.fulfill(NO); return }
      if (m === 'GET') {
        listGets++
        if (failList > 0) { failList--; await route.fulfill(NO); return }
        if (busyList) {
          const r = await route.fetch()
          const j = await r.json()
          for (const x of j.rooms) x.align_status = 'running'
          await route.fulfill({ response: r, json: j })
          return
        }
      }
      await route.continue()
    })
    await c.route(/\/api\/rooms\/[^/]+\/align$/, async (route) => {
      if (failAlign) { await route.fulfill(NO); return }
      await route.continue()
    })
    await c.route(/\/api\/(scenes|rooms)\/[^/?]+$/, async (route) => {
      if (route.request().method() === 'PUT' && renameGate) { renames++; await renameGate }
      await route.continue()
    })
  }
  const P = await open({ scene, setup })
  const page = P.page
  ev.check('scenes: the planner opens the scene', P.hookOk && (await ensureScene(page, scene)).ok, P.why)
  const roomsOnServer = async () => (await raw(srv.base, 'GET', '/api/rooms', {})).json?.rooms ?? []
  const pickRoomFiles = (names) => page.locator('[data-midstudy="room-files"]').setInputFiles(names.map(file))
  const toastSaying = (t) => page.waitForFunction((x) => [...document.querySelectorAll('#toasts .toast:not(.is-leaving)')].some((e) => e.textContent.includes(x)), t, { timeout: 30000 }).then(() => true, () => false)
  const clickToast = (t) => page.click(`#toasts .toast:not(.is-leaving) .toast-action:has-text("${t}")`)

  // --- two uploads: a card each, and only the last one opens -------------------------------------------------------------
  await openPage(page)
  const created = new Map()
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && /\/api\/scenes$/.test(r.url()) && r.status() === 202) created.set(r.request().headers()['x-midstudy-filename'], (await r.json().catch(() => null))?.scene)
  })
  const h1 = hold()
  const h2 = hold()
  holds.set('one.jpg', h1)
  holds.set('two.jpg', h2)
  await page.locator('[data-midstudy="scene-file"]').setInputFiles(file('one.jpg'))
  await page.waitForSelector(CARDS)
  // a drop: the same bytes as a File, through a real drop event
  await page.evaluate(async (name) => {
    const src = window.midstudyCtx.scenes.getScene(name).photo_url
    const blob = await (await fetch(src)).blob()
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'two.jpg', { type: 'image/jpeg' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, scene)
  await waitFor(async () => ((await page.locator(CARDS).count()) === 2 ? true : null), { timeoutMs: 5000 }).catch(() => null)
  const names = await page.locator(`${CARDS} .sc-title`).allTextContents()
  ev.check('scenes: two uploads at once show two cards, each with its name', names.length === 2 && names.includes('one.jpg') && names.includes('two.jpg'), names.join(' | '))
  h1.release()
  await waitFor(async () => (created.has('one.jpg') ? true : null), { timeoutMs: 15000 }).catch(() => null)
  await sleep(600)
  const after1 = await shownScene(page)
  const left = await page.locator(`${CARDS} .sc-title`).allTextContents()
  ev.check('scenes: the earlier upload finishing opens nothing and leaves the later card', after1 === scene && left.join() === 'two.jpg', `${after1}; ${left.join(' | ')}`)
  h2.release()
  const opened = await waitFor(async () => { const n = created.get('two.jpg'); return n && (await shownScene(page)) === n ? n : null }, { timeoutMs: 30000 }).catch(() => null)
  ev.check('scenes: the opened scene is the upload started last', !!opened, `${String(await shownScene(page))} want ${String(created.get('two.jpg'))}`)
  holds.clear()
  await ensureScene(page, scene)

  // --- New room: the room's POST fails, the photos resume without another upload -----------------------------------------
  await openPage(page)
  const base = (await roomsOnServer()).length
  const uploadsBefore = created.size
  failRoom = true
  await pickRoomFiles(['r1.jpg', 'r2.jpg'])
  const offered = await toastSaying('Make the room from 2 photos')
  ev.check('scenes: a failed room create offers "Make the room from 2 photos"', offered, (await page.evaluate(TOASTS)).join(' | '))
  ev.check('scenes: nothing was made', (await roomsOnServer()).length === base, String((await roomsOnServer()).length))
  failRoom = false
  if (offered) await clickToast('Make the room from 2 photos')
  const made = await waitFor(async () => ((await roomsOnServer()).length === base + 1 ? true : null), { timeoutMs: 20000 }).catch(() => false)
  const card = await page.waitForSelector('[data-midstudy="room-card"]', { timeout: 15000 }).then(() => true, () => false)
  ev.check('scenes: the resume makes the room from those photos, with no new upload', !!made && card && created.size === uploadsBefore + 2, `made ${String(made)} card ${card} uploads ${created.size - uploadsBefore}`)

  // --- New room: only the align POST fails, the toast offers align and there is one room --------------------------------
  const base2 = (await roomsOnServer()).length
  failAlign = true
  await pickRoomFiles(['a1.jpg', 'a2.jpg'])
  const alignOffered = await toastSaying('Align the photos')
  const texts = (await page.evaluate(TOASTS)).join(' | ')
  ev.check('scenes: a failed align says the room was made and offers align, not a new room', alignOffered && /is made/.test(texts) && !/Make the room from/.test(texts), texts)
  ev.check('scenes: one room, not two', (await roomsOnServer()).length === base2 + 1, String((await roomsOnServer()).length - base2))
  failAlign = false
  let aligns = 0
  const count = (r) => { if (r.method() === 'POST' && /\/align$/.test(r.url())) aligns++ }
  page.on('request', count)
  if (alignOffered) await clickToast('Align the photos')
  await waitFor(async () => (aligns === 1 ? true : null), { timeoutMs: 10000 }).catch(() => null)
  page.off('request', count)
  await sleep(300)
  ev.check('scenes: the retry aligns that room and creates none', aligns === 1 && (await roomsOnServer()).length === base2 + 1, `aligns ${aligns}; rooms ${(await roomsOnServer()).length - base2}`)

  // --- one New room at a time --------------------------------------------------------------------------------------------
  const h3 = hold()
  holds.set('s1.jpg', h3)
  await pickRoomFiles(['s1.jpg', 's2.jpg'])
  await page.waitForSelector('.sc-card.is-uploading.rm-card:not([hidden])')
  await pickRoomFiles(['t1.jpg', 't2.jpg'])
  ev.check('scenes: a second New room is refused while one runs', await toastSaying('A room is already being made'), (await page.evaluate(TOASTS)).join(' | '))
  const roomsNow = (await roomsOnServer()).length
  h3.release()
  await waitFor(async () => ((await roomsOnServer()).length === roomsNow + 1 ? true : null), { timeoutMs: 20000 }).catch(() => null)
  await sleep(1000)
  ev.check('scenes: only the first run made a room', (await roomsOnServer()).length === roomsNow + 1 && !created.has('t1.jpg'), `rooms +${(await roomsOnServer()).length - roomsNow}`)
  holds.clear()

  // --- a double Enter renames once ----------------------------------------------------------------------------------------
  await openPage(page)
  const twice = async (what) => {
    let release = () => {}
    renameGate = new Promise((r) => { release = r })
    renames = 0
    await page.waitForSelector('.sc-rename input')
    await page.fill('.sc-rename input', `Renamed ${what}`)
    await page.press('.sc-rename input', 'Enter')
    await page.press('.sc-rename input', 'Enter')
    await sleep(400)
    const disabled = await page.locator('.sc-rename button:has-text("Save")').isDisabled()
    release()
    renameGate = null
    await page.waitForSelector('.sc-rename', { state: 'detached', timeout: 10000 }).catch(() => null)
    ev.check(`scenes: two quick Enters in Rename ${what} write once, Save disabled meanwhile`, renames === 1 && disabled, `writes ${renames}; disabled ${disabled}`)
  }
  await page.click(`[data-midstudy="scene-card"][data-scene="${other}"] [aria-label^="Rename"]`)
  await twice('scene')
  await page.click('[data-midstudy="room-card"] [aria-label^="More for"]')
  await page.click('.menu-item:has-text("Rename")')
  await twice('room')

  // --- a failed list keeps the room poll going ------------------------------------------------------------------------------
  await closePage(page)
  busyList = true
  await page.evaluate(() => window.midstudyCtx.engine.listRoomsInternal().catch(() => undefined)) // the rooms read as busy
  failList = 2 // the page's first read and the poll's first both fail; the third read is the poll going on
  listGets = 0
  await openPage(page)
  await waitFor(async () => (listGets >= 3 ? true : null), { timeoutMs: 12000 }).catch(() => null)
  ev.check('scenes: the room poll goes on after failed reads', listGets >= 3, `reads ${listGets}`)
  busyList = false
  await closePage(page)

  // --- a confirm over a scene that changed meanwhile acts on nothing ---------------------------------------------------
  const dirty = async () => {
    await ensureScene(page, scene)
    const a = await hook(page, 'addItem', [PROBE])
    if (a.error) ev.check('scenes: a piece placed', false, a.error)
  }
  const overConfirm = async () => {
    await page.waitForSelector('.dialog')
    await hook(page, 'openScene', [third], 30000)
    await page.click('.dialog-actions button.btn-primary')
  }
  await dirty()
  await openPage(page)
  await page.click(`[data-midstudy="scene-card"][data-scene="${other}"] .sc-open`)
  await overConfirm()
  await sleep(800)
  ev.check('scenes: Open anyway after another scene opened keeps that scene', (await shownScene(page)) === third, String(await shownScene(page)))
  await closePage(page)

  await dirty()
  await openPage(page)
  await page.click('[data-midstudy="room-card"] .sc-open')
  await overConfirm()
  await sleep(800)
  ev.check('scenes: Open room after another scene opened keeps that scene', (await shownScene(page)) === third && (await page.evaluate(() => window.midstudyCtx.engine.getRoomState())) === null, String(await shownScene(page)))
  await closePage(page)

  await dirty()
  await page.locator('[data-midstudy="scene-file"]').setInputFiles(file('moved.jpg'))
  await overConfirm()
  const uploaded = await waitFor(async () => (created.has('moved.jpg') ? true : null), { timeoutMs: 15000 }).catch(() => null)
  await sleep(800)
  ev.check('scenes: an upload confirmed after another scene opened still uploads, and does not open', !!uploaded && (await shownScene(page)) === third, `${String(uploaded)} ${String(await shownScene(page))}`)
}
