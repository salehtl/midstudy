// Export (main a292ee2): the scene as drawn, saved as an image file. No AI, nothing is sent, free: the same passes a
// render captures (engine.exportImage), at a size preset, as JPEG or PNG, alone or as Before and after (the photo next
// to the scene: side by side for an upright photo, one above the other for a wide one). The choices are remembered on
// this device. The Export tool and ⌘E open it (ui/workspace.ts). On a phone that can share files, Share… sits beside
// Save. Choices and names: ui/logic/export.ts. Styles: styles/manage.css (.ex-*).
// ctx.exporter: { open(), exportNow(opts) → { blob, name, width, height } }
import { openSheet, type Sheet } from './sheet.js'
import { quiet, type ExportOptions, type UiContext } from './seam.js'
import { FORMATS, LAYOUTS, dimsFor, exportName, formatOf, pairShape, rememberedChoices, sizesFor } from './logic/export.js'

const PREF_KEY = 'midstudy.export'
const store = {
  get: (): unknown => { try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') } catch { return {} } },
  set: (v: unknown): void => { try { localStorage.setItem(PREF_KEY, JSON.stringify(v)) } catch { /* private mode */ } },
}
const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((res, rej) => {
  const i = new Image()
  i.onload = () => { res(i) }
  i.onerror = () => { rej(new Error(`could not load ${src}`)) }
  i.src = src
})
const toBlob = (c: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((res) => { c.toBlob(res, type, type === 'image/jpeg' ? quality : undefined) })

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { engine, shell, kit } = ctx
  const { h, button, segmented } = kit
  let sheet: Sheet | null = null
  const photoSize = (): { w: number; h: number } => { const p = engine.getPhotoSize(); return { w: p.w, h: p.h } }
  const fileName = (o: { format: string; layout: string }, w: number, hh: number): string => {
    const sc = engine.getScene()
    return exportName(sc ? { title: sc.title ?? null, name: sc.name } : null, engine.layoutDisplayName(engine.getLayoutName()), o.layout === 'pair', o.format, w, hh)
  }

  async function exportNow(opts: ExportOptions = {}): Promise<{ blob: Blob; name: string; width: number; height: number }> {
    const o = { size: opts.size ?? 'full', format: opts.format ?? 'jpeg', layout: opts.layout ?? 'scene', quality: opts.quality ?? 0.92 }
    const fmt = formatOf(o.format)
    const p = photoSize()
    const { long } = dimsFor(o.size, p.w, p.h)
    if (o.layout !== 'pair') {
      const r = await engine.exportImage({ longEdge: long, type: fmt.type, quality: o.quality })
      if (!r.blob) throw engine.reportError('Could not encode the image')
      return { blob: r.blob, name: fileName(o, r.width, r.height), width: r.width, height: r.height }
    }
    const url = engine.getScene()?.photo_url ?? ''
    const [r, photo] = await Promise.all([
      engine.exportImage({ longEdge: long, encode: false }),
      loadImage(url).catch((e: unknown) => { throw engine.reportError('Could not load the photo for Before and after', e) }),
    ])
    const w = r.width, hh = r.height
    const pair = pairShape(w, hh)
    const c = document.createElement('canvas')
    c.width = pair.w
    c.height = pair.h
    const g = c.getContext('2d')
    if (!g) throw engine.reportError('Could not draw Before and after (no 2D canvas)')
    g.imageSmoothingQuality = 'high'
    g.drawImage(photo, 0, 0, w, hh)
    g.drawImage(r.canvas, pair.stacked ? 0 : w, pair.stacked ? hh : 0)
    // small "Before" / "After" tags in each half's top-left corner
    const fs = Math.max(12, Math.round(Math.max(w, hh) * 0.022))
    g.font = `600 ${String(fs)}px system-ui, -apple-system, sans-serif`
    g.textBaseline = 'middle'
    const tags: readonly (readonly [string, number, number])[] = [['Before', 0, 0], ['After', pair.stacked ? 0 : w, pair.stacked ? hh : 0]]
    for (const [label, x, y] of tags) {
      const pad = Math.round(fs * 0.6), tw = g.measureText(label).width
      const bx = x + pad, by = y + pad, bw = tw + pad * 2, bh = fs + pad
      g.fillStyle = 'rgba(14, 15, 17, 0.72)'
      g.beginPath()
      g.roundRect(bx, by, bw, bh, bh / 2)
      g.fill()
      g.fillStyle = '#ECE8E0'
      g.fillText(label, bx + pad, by + bh / 2)
    }
    const blob = await toBlob(c, fmt.type, o.quality)
    if (!blob) throw engine.reportError('Could not encode the image')
    return { blob, name: fileName(o, c.width, c.height), width: c.width, height: c.height }
  }

  function save(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.hidden = true
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => { URL.revokeObjectURL(url) }, 60000)
  }

  async function open(): Promise<void> {
    if (!engine.getSceneName() || engine.getSceneLoad().loading) { shell.toast('Open a scene first.', { id: 'no-scene' }); return }
    if (sheet?.isOpen()) return
    const p = photoSize()
    const sizes = sizesFor(Math.max(p.w, p.h))
    const o = rememberedChoices(store.get(), sizes)
    let busy = false
    let preview
    try { preview = await engine.captureComposite({ maxPx: 720, quality: 0.8 }) } catch (e) { engine.reportError('Could not capture the scene', e); return }
    if (sheet?.isOpen()) return
    const phone = shell.isPhone()
    const remember = (): void => { store.set(o) }

    const img = h('img', { src: preview.dataUrl, alt: 'The scene as it will be saved' })
    const before = h('img.ex-before', { src: engine.getScene()?.photo_url ?? '', alt: 'The photo' })
    const pv = h('div.ex-preview', before, img)
    const info = h('p.ex-info.tnum')
    const go = button({ label: 'Save image', kind: 'primary', block: phone, onClick: () => { quiet(run('save')) } })
    go.classList.add('ms-primary')
    go.dataset['midstudy'] = 'export-go'
    const canShare = phone && typeof navigator.canShare === 'function' && (() => { try { return navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }) } catch { return false } })()
    const share = canShare ? button({ label: 'Share…', kind: 'secondary', onClick: () => { quiet(run('share')) } }) : null
    function sync(): void {
      const d = dimsFor(o.size, p.w, p.h)
      const out = o.layout === 'pair' ? pairShape(d.w, d.h) : d
      const fmt = formatOf(o.format)
      info.textContent = `${String(out.w)} × ${String(out.h)} ${fmt.label} · ${fmt.note}`
      pv.dataset['layout'] = o.layout
      pv.dataset['shape'] = d.w >= d.h ? 'wide' : 'tall'
      go.disabled = busy
      if (share) share.disabled = busy
      const label = go.lastChild
      if (label) label.textContent = busy ? 'Saving…' : 'Save image'
    }
    const row = (label: string, control: Node): HTMLElement => h('div.ms-row', h('span.ms-label', label), control)
    const seg = (opts: readonly { readonly id: string; readonly label: string }[], key: 'size' | 'format' | 'layout'): HTMLElement => {
      const s = segmented(opts.map((x) => ({ value: x.id, label: x.label })), o[key], (v) => { o[key] = v; remember(); sync() }, { label: key })
      s.classList.add('ms-seg')
      s.dataset['midstudy'] = `export-${key}`
      return s
    }
    const full = dimsFor('full', p.w, p.h)
    const sizeOpts = sizes.map((s) => (s.id === 'full' ? { ...s, label: `Full · ${String(full.w)} × ${String(full.h)}` } : s))
    const body = h('div.ms-form.ex',
      pv,
      row('Size', seg(sizeOpts, 'size')),
      row('Format', seg(FORMATS, 'format')),
      row('Picture', seg(LAYOUTS, 'layout')),
      info,
      h('p.ms-note', ctx.icons.icon('info', { size: 14 }), h('span', 'The view as drawn here, without AI: free, and nothing leaves this device. For a photoreal image, use Render.')))

    async function run(how: 'save' | 'share'): Promise<void> {
      if (busy) return
      busy = true
      sync()
      try {
        const r = await exportNow(o)
        if (how === 'share') {
          const file = new File([r.blob], r.name, { type: r.blob.type })
          try { await navigator.share({ files: [file], title: r.name }) } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) throw e }
        } else {
          save(r.blob, r.name)
          shell.toast(`Saved ${r.name}`, { kind: 'ok', id: 'export-saved', ms: 5000 })
        }
        sheet?.close()
      } catch (e) {
        if (!(e instanceof Error && engine.errors.includes(e.message))) engine.reportError('Export failed', e)
      } finally {
        busy = false
        if (sheet?.isOpen()) sync()
      }
    }
    sheet = openSheet(shell, {
      title: 'Export image', sub: 'Free · no AI', label: 'Export image', cls: 'ex-sheet', body,
      actions: [phone ? null : button({ label: 'Cancel', kind: 'secondary', onClick: () => { sheet?.close() } }), share, go],
      onClose: () => { sheet = null },
    })
    sync()
  }

  ctx.exporter = { open: () => { quiet(open()) }, exportNow }
}
