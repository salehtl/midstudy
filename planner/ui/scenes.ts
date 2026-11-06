// Scenes (contract §4.5, §4.9): every scene and room on the server, newest first, as a grid of photos; a room is one
// card with its photos inside (room-card, data-room), and its scenes aren't shown again. New room (room-new) takes
// several photos at once (room-files), uploads each, makes the room in that order and asks for an alignment; a room's
// menu renames it, adds a photo (room-add), removes one (room-remove, data-scene) and deletes it (room-delete, with
// Undo and Recently deleted → room-restore). Phone: a full-height page;
// desktop: an overlay under the bar. New scene (a file picker that takes camera-roll photos on iOS), open, rename and
// delete; a scene that's still calibrating shows its photo with a spinner and opens when it's done. Styles:
// styles/scenes.css (.sc-*). The file input (data-midstudy="scene-file") stays in the page at all times. The words:
// logic/scenes.ts.
import { icon, ring } from './icons.js'
import { fmtBytes, friendlyDate, quiet, relDate, sceneTitle, type RoomInfo, type SceneSummary, type TrashedRoom, type TrashedScene, type UiContext } from './seam.js'
import { newRoomHelp, newRoomStep, photoLabel, roomBusyText, roomFlag, roomMeta, roomTitleText, type RoomFacts } from './logic/rooms.js'
import { openSheet } from './sheet.js'
import type { Child } from './kit.js'
import { busyText, deleteBody, isPhotoFile, sceneFlags, sceneMeta, scenesHint, uploadProgress } from './logic/scenes.js'
import { sceneBusy } from '../logic/scenes.js'
import { uniqueBy } from './logic/lists.js'
import * as textLogic from './logic/text.js'

interface Uploading {
  readonly name: string
  readonly loaded: number
  readonly total: number
}

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { engine, scenes, shell, kit } = ctx
  const { h, button } = kit
  const { dots } = textLogic
  let uploading: Uploading | null = null
  const root = h('div.sc-root')
  const page = shell.registerPage({ id: 'scenes', label: 'Scenes', width: 940, mount: (body) => { body.append(root) }, onOpen: () => { quiet(scenes.refresh()); quiet(engine.listRoomsInternal().then(() => { render(); schedulePoll() }).catch(() => undefined)); render() } })

  // The file picker: accept="image/*" lets iOS offer the camera roll (and the camera); HEIC is listed for desktops.
  const file: HTMLInputElement = h('input.sc-file', { type: 'file', accept: 'image/*,.heic,.heif', 'aria-label': 'Photo of the room', dataset: { midstudy: 'scene-file' },
    onchange: () => { const f = file.files?.[0]; file.value = ''; if (f) quiet(upload(f)) } })
  document.body.append(file)
  const newBtn = h('button.btn.btn-primary.sc-new', { type: 'button', dataset: { midstudy: 'scene-new' }, onclick: () => { pick() } }, icon('plus', { size: 18 }), h('span', 'New scene'))
  const settingsBtn = h('button.btn.btn-secondary.sc-settings', { type: 'button', 'aria-label': 'Settings', dataset: { midstudy: 'settings', tip: 'Settings (daily fal budget)' }, onclick: () => { ctx.settings?.open() } }, icon('settings', { size: 18 }), h('span', 'Settings'))
  // New room (§4.9): several photos at once; the sheet has the help text and an optional title
  const roomFiles: HTMLInputElement = h('input.sc-file', { type: 'file', accept: 'image/*,.heic,.heif', 'aria-label': 'Photos of the room', dataset: { midstudy: 'room-files' },
    onchange: () => { const fs = [...(roomFiles.files ?? [])]; roomFiles.value = ''; if (fs.length) quiet(makeRoom(fs)) } })
  roomFiles.multiple = true
  document.body.append(roomFiles)
  const roomBtn = h('button.btn.btn-secondary.sc-room-new', { type: 'button', 'aria-label': 'New room', dataset: { midstudy: 'room-new', tip: 'Several photos of one room, one layout' }, onclick: () => { newRoom() } }, icon('rooms', { size: 18 }), h('span', 'New room'))
  page.actions.append(settingsBtn, roomBtn, newBtn)
  let roomTitle = ''
  let roomMaking: { readonly text: string; readonly n: number } | null = null
  let roomSheet: ReturnType<typeof openSheet> | null = null
  const roomUploads = new Set<string>() // photos uploaded for a room (no "is ready" toast each)

  function pick(): void { file.click() }

  async function upload(f: File): Promise<void> {
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const ok = await shell.confirm({ title: 'Leave this layout?', icon: 'warning', body: "The furniture here isn't saved as a layout. The new scene opens when it's ready, without it.", confirm: 'Make the new scene' })
      if (!ok) return
    }
    uploading = { name: f.name || 'photo', loaded: 0, total: f.size }
    render()
    let res: { readonly scene: string }
    try {
      res = await scenes.upload(f, { onProgress: (loaded, total) => { uploading = { ...(uploading ?? { name: '' }), loaded, total }; renderUpload() } })
    } catch { uploading = null; render(); return } // reported
    uploading = null
    render()
    shell.closePage()
    try { await engine.openScene(res.scene) } catch { shell.openPage('scenes') }
  }

  async function open(s: SceneSummary): Promise<void> {
    if (s.name === engine.getSceneName()) { shell.closePage(); return }
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const v = await shell.confirm({ title: `Open ${sceneTitle(s)}?`, icon: 'warning', body: "The furniture here isn't saved as a layout. Opening another scene clears it.", confirm: 'Open anyway' })
      if (!v) return
    }
    shell.closePage()
    try { await engine.openScene(s.name) } catch { shell.openPage('scenes') }
  }

  function rename(s: SceneSummary): void {
    const input = h('input.input', { type: 'text', value: s.title ?? '', placeholder: sceneTitle({ created: s.created ?? null, name: s.name }), maxLength: 200, spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Scene title' })
    const save = async (): Promise<void> => {
      try { await scenes.rename(s.name, input.value) } catch { return }
      sheet.close()
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quiet(save()) } })
    const sheet = openSheet(shell, {
      title: 'Rename scene', sub: s.name, cls: 'sc-rename',
      body: h('label.field', h('span.field-label', 'Title'), input),
      actions: [button({ label: 'Cancel', kind: 'quiet', onClick: () => { sheet.close() } }), button({ label: 'Save', kind: 'primary', onClick: () => { quiet(save()) } })],
    })
    requestAnimationFrame(() => { input.focus(); input.select() })
  }

  async function remove(s: SceneSummary): Promise<void> {
    const ok = await shell.confirm({ title: `Delete ${sceneTitle(s)}?`, icon: 'trash', danger: true, confirm: 'Delete', body: deleteBody((s.layouts ?? 0) || 0) })
    if (!ok) return
    try { await scenes.remove(s.name) } catch { return }
    const t = shell.toast(`${sceneTitle(s)} deleted`, { id: `scene-deleted:${s.name}`, icon: 'trash', ms: 10000, action: { label: 'Undo', onClick: () => { quiet(restore(s)) } } })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'scene-undo')
  }
  async function restore(s: SceneSummary | TrashedScene): Promise<void> {
    try { await engine.restoreScene(s.name) } catch { return } // reported
    shell.toast(`${sceneTitle(s)} is back`, { kind: 'ok', id: `scene-deleted:${s.name}` })
  }

  // --- render ---------------------------------------------------------------------------------------------------
  function card(s: SceneSummary): HTMLDivElement {
    const isOpen = s.name === engine.getSceneName()
    const busy = sceneBusy(s.calib_status)
    const src = (s.thumb_url ?? '') || s.photo_url
    const thumb = h('span.sc-thumb', src ? h('img', { src, alt: '', loading: 'lazy', draggable: false }) : h('span.sc-thumb-none', icon('image', { size: 28 })))
    if (busy) thumb.append(h('span.sc-busy', ring(null, { size: 28 }), h('span', busyText(!!s.photo_url))))
    const flags = sceneFlags(s, isOpen).map((f) => h(`span.sc-flag${f.cls ? `.${f.cls}` : ''}`, f.title === null ? null : { title: f.title }, f.text))
    const meta = sceneMeta(s, s.title ? relDate(s.created) : '')
    const main = h('button.sc-open', { type: 'button', 'aria-label': `Open ${sceneTitle(s)}`, onclick: () => { quiet(open(s)) } },
      thumb, h('span.sc-text', h('span.sc-title', sceneTitle(s)), h('span.sc-meta.tnum', meta)), flags.length ? h('span.sc-flags', flags) : null)
    const acts = h('span.sc-acts',
      h('button.sc-act', { type: 'button', 'aria-label': `Rename ${sceneTitle(s)}`, dataset: { tip: 'Rename' }, onclick: () => { rename(s) } }, icon('pencil', { size: 18 })),
      h('button.sc-act.is-danger', { type: 'button', 'aria-label': `Delete ${sceneTitle(s)}`, dataset: { midstudy: 'scene-delete', tip: 'Delete' }, onclick: () => { quiet(remove(s)) } }, icon('trash', { size: 18 })))
    return h(`div.sc-card${isOpen ? '.is-open' : ''}${busy ? '.is-busy' : ''}`, { role: 'listitem', dataset: { midstudy: 'scene-card', scene: s.name } }, main, acts)
  }
  const upEl = h('div.sc-card.is-uploading', { hidden: true })
  function renderUpload(): void {
    if (!uploading) { upEl.hidden = true; return }
    const p = uploadProgress(uploading.loaded, uploading.total)
    upEl.hidden = false
    upEl.replaceChildren(h('span.sc-thumb', h('span.sc-busy', ring(p.progress, { size: 28 }), h('span', p.text))),
      h('span.sc-text', h('span.sc-title', uploading.name), h('span.sc-meta.tnum', dots([fmtBytes(uploading.total), 'new scene']))))
  }
  // --- rooms (§4.9) ---------------------------------------------------------------------------------------------
  function newRoom(): void {
    const input = h('input.input', { type: 'text', value: roomTitle, placeholder: 'Living room', maxLength: 200, spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Room title (optional)',
      oninput: () => { roomTitle = input.value } })
    roomSheet = openSheet(shell, {
      title: 'New room', sub: 'Several photos of one room, one layout', cls: 'rm-new',
      body: h('div.ms-stack', h('label.field', h('span.field-label', 'Title (optional)'), input), h('ul.rm-new-help', newRoomHelp().map((t) => h('li', t)))),
      actions: [button({ label: 'Cancel', kind: 'quiet', onClick: () => { roomSheet?.close() } }), button({ label: 'Choose photos', kind: 'primary', onClick: () => { roomFiles.click() } })],
      onClose: () => { roomSheet = null },
    })
  }
  async function makeRoom(files: readonly File[]): Promise<void> {
    roomSheet?.close()
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const ok = await shell.confirm({ title: 'Leave this layout?', icon: 'warning', body: "The furniture here isn't saved as a layout. The new room opens when it's ready, without it.", confirm: 'Make the room' })
      if (!ok) return
    }
    const title = roomTitle.trim() || null
    const names: string[] = []
    try {
      for (const [i, f] of files.entries()) {
        roomMaking = { text: newRoomStep('upload', i + 1, files.length), n: files.length }
        render()
        const made = (await scenes.upload(f, {})).scene
        names.push(made)
        roomUploads.add(made)
      }
      roomMaking = { text: newRoomStep('room', 0, files.length), n: files.length }
      render()
      const info = await engine.createRoomFromScenes(names, title)
      roomTitle = ''
      if (names.length >= 2) {
        roomMaking = { text: newRoomStep('align', 0, files.length), n: files.length }
        render()
        try { await engine.alignRoomWhenReady(info.name) } catch { /* reported; the room is there, align it later */ }
      }
      shell.toast(`${roomTitleText(info.title, friendlyDate(info.created ?? null), info.name)}: ${String(names.length)} photos uploaded. It opens when they're ready.`, { kind: 'ok', id: `room-made:${info.name}` })
      roomMaking = null
      await engine.listRoomsInternal().catch(() => undefined)
      render()
      schedulePoll()
    } catch {
      roomMaking = null
      render()
    }
  }
  const roomTitleOf = (r: RoomInfo | TrashedRoom): string => roomTitleText(r.title, friendlyDate(r.created ?? null), r.name)
  function factsOf(r: RoomInfo): RoomFacts {
    const busy = r.members.filter((m) => sceneBusy(m.scene_object?.calib_status ?? scenes.getScene(m.scene)?.calib_status)).length
    return { photos: r.members.length, calibrating: busy, placed: r.members.filter((m) => !!m.pose).length, layouts: r.layouts ?? 0, alignStatus: r.align_status ?? 'none', alignError: r.align_error ?? null }
  }
  async function openRoom(r: RoomInfo): Promise<void> {
    if (engine.getRoomState()?.name === r.name) { shell.closePage(); return }
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const v = await shell.confirm({ title: `Open ${roomTitleOf(r)}?`, icon: 'warning', body: "The furniture here isn't saved as a layout. Opening the room clears it.", confirm: 'Open anyway' })
      if (!v) return
    }
    shell.closePage()
    try { await engine.openRoom(r.name) } catch { shell.openPage('scenes') }
  }
  function renameRoom(r: RoomInfo): void {
    const input = h('input.input', { type: 'text', value: r.title ?? '', placeholder: roomTitleOf({ ...r, title: null }), maxLength: 200, spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Room title' })
    const save = async (): Promise<void> => {
      try { await engine.renameRoom(r.name, input.value) } catch { return }
      sheet.close()
      quiet(engine.listRoomsInternal().then(render).catch(() => undefined))
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quiet(save()) } })
    const sheet = openSheet(shell, {
      title: 'Rename room', sub: r.name, cls: 'sc-rename',
      body: h('label.field', h('span.field-label', 'Title'), input),
      actions: [button({ label: 'Cancel', kind: 'quiet', onClick: () => { sheet.close() } }), button({ label: 'Save', kind: 'primary', onClick: () => { quiet(save()) } })],
    })
    requestAnimationFrame(() => { input.focus(); input.select() })
  }
  function addPhoto(r: RoomInfo): void {
    const free = scenes.getScenes().filter((s) => !s.room && !r.members.some((m) => m.scene === s.name))
    const rows = free.map((s) => h('button.sc-trash-row.rm-add-row', { type: 'button', dataset: { midstudy: 'room-add-scene', scene: s.name },
      onclick: () => { sheet.close(); quiet(engine.addSceneToRoom(r.name, s.name).then(() => { shell.toast(`${sceneTitle(s)} added to ${roomTitleOf(r)}`, { kind: 'ok' }); render() }).catch(() => undefined)) } },
    h('span.sc-trash-text', h('span.sc-trash-name', sceneTitle(s)), h('span.sc-meta.tnum', relDate(s.created ?? null)))))
    const sheet = openSheet(shell, {
      title: 'Add a photo', sub: roomTitleOf(r),
      body: rows.length ? h('div.sc-trash-list', rows) : h('p.sc-hint', 'Every scene is already in a room. Upload a new photo with New scene, then add it here.'),
      actions: [button({ label: 'Done', kind: 'quiet', onClick: () => { sheet.close() } })],
    })
  }
  async function removePhoto(r: RoomInfo, scene: string): Promise<void> {
    try { await engine.removeSceneFromRoom(r.name, scene) } catch { return }
    shell.toast('Photo taken out of the room (the scene stays)', { kind: 'ok', id: `room-remove:${scene}` })
    render()
  }
  async function deleteRoom(r: RoomInfo): Promise<void> {
    const ok = await shell.confirm({ title: `Delete ${roomTitleOf(r)}?`, icon: 'trash', danger: true, confirm: 'Delete', body: `The room and its layouts move to Recently deleted, where you can restore them. Its ${String(r.members.length)} photos stay as scenes.` })
    if (!ok) return
    try { await engine.deleteRoom(r.name) } catch { return }
    const t = shell.toast(`${roomTitleOf(r)} deleted`, { id: `room-deleted:${r.name}`, icon: 'trash', ms: 10000, action: { label: 'Undo', onClick: () => { quiet(restoreRoom(r)) } } })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'room-undo')
    render()
  }
  async function restoreRoom(r: RoomInfo | TrashedRoom): Promise<void> {
    try { await engine.restoreRoom(r.name) } catch { return }
    shell.toast(`${roomTitleOf(r)} is back`, { kind: 'ok', id: `room-deleted:${r.name}` })
    render()
  }
  function roomMenu(r: RoomInfo, anchor: Element): void {
    shell.menu(anchor, [
      { label: 'Rename', icon: 'pencil', onSelect: () => { renameRoom(r) } },
      { label: 'Add a photo…', icon: 'plus', midstudy: 'room-add', onSelect: () => { addPhoto(r) } },
      ...(r.members.length ? ['-' as const] : []),
      ...r.members.map((m, i) => ({ label: `Remove ${photoLabel(i + 1, sceneTitle(m.scene_object ?? scenes.getScene(m.scene) ?? { name: m.scene }))}`, midstudy: 'room-remove', onSelect: () => { quiet(removePhoto(r, m.scene)) } })),
      '-',
      { label: 'Delete room', icon: 'trash', danger: true, midstudy: 'room-delete', onSelect: () => { quiet(deleteRoom(r)) } },
    ])
    // the menu is built synchronously: give each Remove its photo (data-scene, §4.9 handles)
    const removes = [...document.querySelectorAll<HTMLElement>('#layer [data-midstudy="room-remove"]')]
    removes.forEach((b, i) => { const m = r.members[i]; if (m) b.dataset['scene'] = m.scene })
    const card = anchor.closest('[data-room]')
    if (card) for (const b of document.querySelectorAll<HTMLElement>('#layer [data-midstudy="room-add"], #layer [data-midstudy="room-delete"]')) b.dataset['room'] = r.name
  }
  function roomCard(r: RoomInfo): HTMLDivElement {
    const f = factsOf(r)
    const open = engine.getRoomState()?.name === r.name
    const busyText = roomBusyText(f)
    const shown = r.members.slice(0, r.members.length > 4 ? 3 : 4)
    const thumbs = h('span.rm-card-thumbs', shown.map((m) => {
      const so = m.scene_object ?? scenes.getScene(m.scene)
      const src = (so?.thumb_url ?? '') || so?.photo_url
      return h('span.rm-t', src ? h('img', { src, alt: '', loading: 'lazy', draggable: false }) : h('span.sc-thumb-none', icon('image', { size: 20 })))
    }), r.members.length > 4 ? h('span.rm-t.rm-t-more', `+${String(r.members.length - 3)}`) : null,
    busyText ? h('span.sc-busy', ring(null, { size: 24 }), h('span', busyText)) : null)
    const flag = roomFlag(f)
    const flags = [h('span.sc-flag.is-room', 'Room'), open ? h('span.sc-flag.is-open', 'Open now') : null, flag ? h(`span.sc-flag${f.alignStatus === 'failed' ? '.is-failed' : '.is-check'}`, { title: f.alignError ?? '' }, flag) : null]
    const main = h('button.sc-open', { type: 'button', 'aria-label': `Open ${roomTitleOf(r)}`, onclick: () => { quiet(openRoom(r)) } },
      thumbs, h('span.sc-text', h('span.sc-title', roomTitleOf(r)), h('span.sc-meta.tnum', roomMeta(f, r.title ? relDate(r.created ?? null) : ''))), h('span.sc-flags', flags))
    const more = h('button.sc-act', { type: 'button', 'aria-label': `More for ${roomTitleOf(r)}`, dataset: { tip: 'Rename, add or remove photos, delete' }, onclick: (e) => { roomMenu(r, e.currentTarget instanceof Element ? e.currentTarget : more) } }, icon('more', { size: 18 }))
    return h(`div.sc-card.rm-card${open ? '.is-open' : ''}${busyText ? '.is-busy' : ''}`, { role: 'listitem', dataset: { midstudy: 'room-card', room: r.name } }, main, h('span.sc-acts', more))
  }
  const makingEl = h('div.sc-card.is-uploading.rm-card', { hidden: true })
  function renderMaking(): void {
    if (!roomMaking) { makingEl.hidden = true; return }
    makingEl.hidden = false
    makingEl.replaceChildren(h('span.sc-thumb', h('span.sc-busy', ring(null, { size: 28 }), h('span', roomMaking.text))),
      h('span.sc-text', h('span.sc-title', roomTitle.trim() || 'New room'), h('span.sc-meta.tnum', dots([`${String(roomMaking.n)} photos`, 'new room']))))
  }
  // While a room's photos calibrate or it aligns, the list is read again every 1.5 s (the page open).
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  function schedulePoll(): void {
    clearTimeout(pollTimer)
    const busy = engine.getRooms().some((r) => { const f = factsOf(r); return f.calibrating > 0 || f.alignStatus === 'pending' || f.alignStatus === 'running' })
    if (!busy || !page.isOpen()) return
    pollTimer = setTimeout(() => { quiet(engine.listRoomsInternal().then(() => { render(); schedulePoll() }).catch(() => undefined)) }, 1500)
  }
  function roomTrashView(): HTMLElement | null {
    const trash = engine.getRoomsTrash()
    if (!trash.length) return null
    const rows: Child[] = uniqueBy(trash, (t) => t.name).map((t) => h('div.sc-trash-row', { role: 'listitem' },
      h('span.sc-trash-text', h('span.sc-trash-name', roomTitleOf(t)), h('span.sc-meta.tnum', t.deleted ? `Room · deleted ${relDate(t.deleted)}` : 'Room · deleted')),
      h('button.btn.btn-secondary.sc-restore', { type: 'button', dataset: { midstudy: 'room-restore', room: t.name }, onclick: () => { quiet(restoreRoom(t)) } }, 'Restore')))
    return h('section.sc-trash', h('h3.caps', 'Recently deleted rooms'), h('div.sc-trash-list', { role: 'list' }, rows))
  }

  function render(): void {
    if (!page.isOpen()) return
    const list = scenes.getScenes()
    const st = scenes.getState()
    page.setCount(list.length ? String(list.length) : '')
    root.className = `sc-root ${shell.isPhone() ? 'is-phone' : 'is-desktop'}`
    renderUpload()
    renderMaking()
    const rooms = engine.getRooms()
    const inRooms = new Set(rooms.flatMap((r) => r.members.map((m) => m.scene)))
    const alone = list.filter((s) => !s.room && !inRooms.has(s.name))
    if (!list.length && !uploading && !rooms.length && !roomMaking) {
      fill(st.loaded ? h('div.sc-empty',
        h('span.sc-empty-ic', icon('image', { size: 32 })),
        h('h3', 'No scenes yet'),
        h('p', 'A scene is one photo of a room, taken from where you would stand to look at it. Wide (0.5×) is fine. The floor should be visible.'),
        button({ label: 'Take or choose a photo', kind: 'primary', onClick: () => { pick() } }),
        st.offline ? h('p.sc-offline', "The server isn't answering: check it's running.") : null)
        : h('div.sc-loading', ring(null, { size: 24 }), h('span', 'Loading scenes…')), st.loaded ? trashView() : null)
      return
    }
    fill(
      h('p.sc-hint', scenesHint(shell.isPhone())),
      h('div.sc-grid', { role: 'list' }, makingEl, upEl, rooms.map((r) => roomCard(r)), alone.map((s) => card(s))),
      trashView(), roomTrashView())
  }
  // replaceChildren() turns null into the text "null" (h() drops it; this doesn't): no Recently deleted, no node.
  function fill(...kids: (Node | null)[]): void { root.replaceChildren(...kids.filter((k): k is Node => k !== null)) }
  // Recently deleted: scenes the server keeps in scenes/.trash, each with Restore (its layouts and renders come back).
  function trashView(): HTMLElement | null {
    const trash = engine.getScenesTrash()
    if (!trash.length) return null
    const rows: Child[] = uniqueBy(trash, (t) => t.name).map((t) => h('div.sc-trash-row', { role: 'listitem' },
      h('span.sc-trash-text', h('span.sc-trash-name', sceneTitle(t)), h('span.sc-meta.tnum', t.deleted ? `Deleted ${relDate(t.deleted)}` : 'Deleted')),
      h('button.btn.btn-secondary.sc-restore', { type: 'button', dataset: { midstudy: 'scene-restore', scene: t.name }, onclick: () => { quiet(restore(t)) } }, 'Restore')))
    return h('section.sc-trash', h('h3.caps', 'Recently deleted'), h('div.sc-trash-list', { role: 'list' }, rows))
  }

  scenes.events.addEventListener('scenes', render)
  engine.events.addEventListener('rooms', () => { render() })
  engine.events.addEventListener('room', (e) => { if (e.detail.phase === 'aligned' || e.detail.phase === 'deleted' || e.detail.phase === 'restored') render() })
  scenes.events.addEventListener('ready', (e) => {
    const s = e.detail.scene
    if (s.room || roomUploads.has(s.name) || engine.getRooms().some((r) => r.members.some((m) => m.scene === s.name))) { render(); return } // a room's photo: its card shows it
    if (s.name === engine.getSceneLoad().name || s.name === engine.getSceneName()) return // it's opening (or open) anyway
    shell.toast(`${sceneTitle(s)} is ready`, { kind: 'ok', id: `scene-ready:${s.name}`, action: { label: 'Open', onClick: () => { quiet(open(s)) } } })
  })
  scenes.events.addEventListener('failed', (e) => {
    const s = e.detail.scene
    shell.toast(`${sceneTitle(s)}: calibration failed${s.calib_error ? ` (${s.calib_error})` : ''}. You can still set the floor by hand.`, { kind: 'error', id: `scene-failed:${s.name}` })
  })
  engine.events.addEventListener('scene', render)
  shell.events.addEventListener('mode', render)
  // Drop a photo anywhere (desktop) to make a scene from it.
  window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault() })
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files[0]
    if (!f) return
    e.preventDefault()
    if (!isPhotoFile(f.type, f.name)) { shell.toast(`${f.name} isn't a photo`, { kind: 'error' }); return }
    quiet(upload(f))
  })
}
