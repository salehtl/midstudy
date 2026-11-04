// Scenes (contract §4.5): every scene on the server, newest first, as a grid of photos. Phone: a full-height page;
// desktop: an overlay under the bar. New scene (a file picker that takes camera-roll photos on iOS), open, rename and
// delete; a scene that's still calibrating shows its photo with a spinner and opens when it's done. Styles:
// styles/scenes.css (.sc-*). The file input (data-midstudy="scene-file") stays in the page at all times.
// ctx.scenesPage = { open(), pick() (opens the file picker), upload(file) }
import { icon, ring } from './icons.js'
import { quiet } from '../engine.js'
import { sceneTitle, relDate, fmtBytes } from '../data.js'
import { openSheet } from './sheet.js'

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

export function mount(ctx) {
  const { engine, scenes, shell, kit } = ctx
  const { h, button } = kit
  let uploading = null // { name, loaded, total }
  const root = h('div.sc-root')
  const page = shell.registerPage({ id: 'scenes', label: 'Scenes', width: 940, mount: (body) => body.append(root), onOpen: () => { quiet(scenes.refresh()); render() } })

  // The file picker: accept="image/*" lets iOS offer the camera roll (and the camera); HEIC is listed for desktops.
  const file = h('input.sc-file', { type: 'file', accept: 'image/*,.heic,.heif', 'aria-label': 'Photo of the room', dataset: { midstudy: 'scene-file' },
    onchange: () => { const f = file.files?.[0]; file.value = ''; if (f) quiet(upload(f)) } })
  document.body.append(file)
  const newBtn = h('button.btn.btn-primary.sc-new', { type: 'button', dataset: { midstudy: 'scene-new' }, onclick: () => pick() }, icon('plus', { size: 18 }), h('span', 'New scene'))
  page.actions.append(newBtn)

  function pick() { file.click() }

  async function upload(f) {
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const ok = await shell.confirm({ title: 'Leave this layout?', icon: 'warning', body: "The furniture here isn't saved as a layout. The new scene opens when it's ready, without it.", confirm: 'Make the new scene' })
      if (!ok) return
    }
    uploading = { name: f.name || 'photo', loaded: 0, total: f.size }
    render()
    let res
    try {
      res = await scenes.upload(f, { onProgress: (loaded, total) => { uploading = { ...uploading, loaded, total }; renderUpload() } })
    } catch { uploading = null; render(); return } // reported
    uploading = null
    render()
    shell.closePage()
    try { await engine.openScene(res.scene) } catch { shell.openPage('scenes') }
  }

  async function open(s) {
    if (s.name === engine.getSceneName()) { shell.closePage(); return }
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const v = await shell.confirm({ title: `Open ${sceneTitle(s)}?`, icon: 'warning', body: "The furniture here isn't saved as a layout. Opening another scene clears it.", confirm: 'Open anyway' })
      if (!v) return
    }
    shell.closePage()
    try { await engine.openScene(s.name) } catch { shell.openPage('scenes') }
  }

  function rename(s) {
    const input = h('input.input', { type: 'text', value: s.title || '', placeholder: sceneTitle({ created: s.created, name: s.name }), maxLength: 200, spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Scene title' })
    const save = async () => {
      try { await scenes.rename(s.name, input.value) } catch { return }
      sheet.close()
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quiet(save()) } })
    const sheet = openSheet(shell, {
      title: 'Rename scene', sub: s.name, cls: 'sc-rename',
      body: h('label.field', h('span.field-label', 'Title'), input),
      actions: [button({ label: 'Cancel', kind: 'quiet', onClick: () => sheet.close() }), button({ label: 'Save', kind: 'primary', onClick: () => quiet(save()) })],
    })
    requestAnimationFrame(() => { input.focus(); input.select() })
  }

  async function remove(s) {
    const n = s.layouts || 0
    const ok = await shell.confirm({ title: `Delete ${sceneTitle(s)}?`, icon: 'trash', danger: true, confirm: 'Delete',
      body: `The photo${n ? ` and its ${plural(n, 'layout')}` : ''} move to Recently deleted, where you can restore ${n ? 'them' : 'it'}. Its renders come back with it.` })
    if (!ok) return
    try { await scenes.remove(s.name) } catch { return }
    const t = shell.toast(`${sceneTitle(s)} deleted`, { id: `scene-deleted:${s.name}`, icon: 'trash', ms: 10000, action: { label: 'Undo', onClick: () => quiet(restore(s)) } })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'scene-undo')
  }
  async function restore(s) {
    try { await engine.restoreScene(s.name) } catch { return } // reported
    shell.toast(`${sceneTitle(s)} is back`, { kind: 'ok', id: `scene-deleted:${s.name}` })
  }

  // --- render ---------------------------------------------------------------------------------------------------
  const busy = (s) => s.calib_status === 'pending' || s.calib_status === 'running'
  function card(s) {
    const isOpen = s.name === engine.getSceneName()
    const src = s.thumb_url || s.photo_url
    const thumb = h('span.sc-thumb', src ? h('img', { src, alt: '', loading: 'lazy', draggable: false }) : h('span.sc-thumb-none', icon('image', { size: 28 })))
    if (busy(s)) thumb.append(h('span.sc-busy', ring(null, { size: 28 }), h('span', s.photo_url ? 'Finding the floor…' : 'Reading the photo…')))
    const flags = []
    if (isOpen) flags.push(h('span.sc-flag.is-open', 'Open now'))
    if (s.calib_status === 'failed') flags.push(h('span.sc-flag.is-failed', { title: s.calib_error || '' }, 'Calibration failed'))
    else if (!busy(s) && s.floor_found === false && s.camera_source !== 'manual') flags.push(h('span.sc-flag.is-check', 'Check the floor'))
    else if (s.camera_source === 'manual') flags.push(h('span.sc-flag', 'Floor set by hand'))
    const meta = [s.title ? relDate(s.created) : null, s.w ? `${s.w} × ${s.h}` : null, s.layouts ? plural(s.layouts, 'layout') : 'no layouts'].filter(Boolean).join(' · ')
    const main = h('button.sc-open', { type: 'button', 'aria-label': `Open ${sceneTitle(s)}`, onclick: () => quiet(open(s)) },
      thumb, h('span.sc-text', h('span.sc-title', sceneTitle(s)), h('span.sc-meta.tnum', meta)), flags.length ? h('span.sc-flags', flags) : null)
    const acts = h('span.sc-acts',
      h('button.sc-act', { type: 'button', 'aria-label': `Rename ${sceneTitle(s)}`, dataset: { tip: 'Rename' }, onclick: () => rename(s) }, icon('pencil', { size: 18 })),
      h('button.sc-act.is-danger', { type: 'button', 'aria-label': `Delete ${sceneTitle(s)}`, dataset: { midstudy: 'scene-delete', tip: 'Delete' }, onclick: () => quiet(remove(s)) }, icon('trash', { size: 18 })))
    return h(`div.sc-card${isOpen ? '.is-open' : ''}${busy(s) ? '.is-busy' : ''}`, { role: 'listitem', dataset: { midstudy: 'scene-card', scene: s.name } }, main, acts)
  }
  const upEl = h('div.sc-card.is-uploading', { hidden: true })
  function renderUpload() {
    if (!uploading) { upEl.hidden = true; return }
    const p = uploading.total ? uploading.loaded / uploading.total : null
    upEl.hidden = false
    upEl.replaceChildren(h('span.sc-thumb', h('span.sc-busy', ring(p != null && p < 1 ? p : null, { size: 28 }), h('span', p != null && p < 1 ? `Uploading ${Math.round(p * 100)} %` : 'Starting…'))),
      h('span.sc-text', h('span.sc-title', uploading.name), h('span.sc-meta.tnum', [fmtBytes(uploading.total), 'new scene'].filter(Boolean).join(' · '))))
  }
  function render() {
    if (!page.isOpen()) return
    const list = scenes.getScenes()
    const st = scenes.getState()
    page.setCount(list.length ? String(list.length) : '')
    root.className = `sc-root ${shell.isPhone() ? 'is-phone' : 'is-desktop'}`
    renderUpload()
    if (!list.length && !uploading) {
      fill(st.loaded ? h('div.sc-empty',
        h('span.sc-empty-ic', icon('image', { size: 32 })),
        h('h3', 'No scenes yet'),
        h('p', 'A scene is one photo of a room, taken from where you would stand to look at it. Wide (0.5×) is fine. The floor should be visible.'),
        button({ label: 'Take or choose a photo', kind: 'primary', onClick: () => pick() }),
        st.offline ? h('p.sc-offline', "The server isn't answering: check it's running.") : null)
        : h('div.sc-loading', ring(null, { size: 24 }), h('span', 'Loading scenes…')), st.loaded ? trashView() : null)
      return
    }
    fill(
      h('p.sc-hint', shell.isPhone() ? 'Tap a scene to open it.' : 'Click a scene to open it. Each scene keeps its own layouts and renders.'),
      h('div.sc-grid', { role: 'list' }, upEl, list.map(card)),
      trashView())
  }
  // replaceChildren() turns null into the text "null" (h() drops it; this doesn't): no Recently deleted, no node.
  function fill(...kids) { root.replaceChildren(...kids.filter((k) => k != null && k !== false)) }
  // Recently deleted: scenes the server keeps in scenes/.trash, each with Restore (its layouts and renders come back).
  function trashView() {
    const trash = engine.getScenesTrash()
    if (!trash.length) return null
    const seen = new Set()
    const rows = trash.filter((t) => !seen.has(t.name) && seen.add(t.name)).map((t) => h('div.sc-trash-row', { role: 'listitem' },
      h('span.sc-trash-text', h('span.sc-trash-name', sceneTitle(t)), h('span.sc-meta.tnum', t.deleted ? `Deleted ${relDate(t.deleted)}` : 'Deleted')),
      h('button.btn.btn-secondary.sc-restore', { type: 'button', dataset: { midstudy: 'scene-restore', scene: t.name }, onclick: () => quiet(restore(t)) }, 'Restore')))
    return h('section.sc-trash', h('h3.caps', 'Recently deleted'), h('div.sc-trash-list', { role: 'list' }, rows))
  }

  scenes.events.addEventListener('scenes', render)
  scenes.events.addEventListener('ready', (e) => {
    const s = e.detail.scene
    if (s.name === engine.getSceneLoad().name || s.name === engine.getSceneName()) return // it's opening (or open) anyway
    shell.toast(`${sceneTitle(s)} is ready`, { kind: 'ok', id: `scene-ready:${s.name}`, action: s.name === engine.getSceneName() ? undefined : { label: 'Open', onClick: () => quiet(open(s)) } })
  })
  scenes.events.addEventListener('failed', (e) => {
    const s = e.detail.scene
    shell.toast(`${sceneTitle(s)}: calibration failed${s.calib_error ? ` (${s.calib_error})` : ''}. You can still set the floor by hand.`, { kind: 'error', id: `scene-failed:${s.name}` })
  })
  engine.events.addEventListener('scene', render)
  shell.events.addEventListener('mode', render)
  // Drop a photo anywhere (desktop) to make a scene from it.
  window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault() })
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0]
    if (!f) return
    e.preventDefault()
    if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name)) { shell.toast(`${f.name} isn't a photo`, { kind: 'error' }); return }
    quiet(upload(f))
  })
  ctx.scenesPage = { open: () => shell.openPage('scenes'), pick, upload }
}
