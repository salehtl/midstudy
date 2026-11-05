// Export: the scene as drawn, saved as an image file. No AI, nothing is sent, free: the same two passes a render
// captures (engine.exportImage), at a size preset, as JPEG or PNG, alone or as Before and after (the photo next to the
// scene: side by side for an upright photo, one above the other for a wide one). The choices are remembered on this
// device. The Export tool and ⌘E open it (ui/workspace.js). On a phone that can share files, Share… sits beside Save.
// Styles: styles/manage.css (.ex-*). ctx.exporter: { open(), exportNow(opts) → { blob, name, width, height } }
import { openSheet } from './sheet.js'
import { quiet } from '../engine.js'

const PREF_KEY = 'midstudy.export'
const SIZES = [
  { id: 'full', label: 'Full', long: null, note: 'the photo’s own size' },
  { id: 'l', label: '2048 px', long: 2048 },
  { id: 'm', label: '1280 px', long: 1280 },
  { id: 's', label: '800 px', long: 800 },
]
const FORMATS = [
  { id: 'jpeg', label: 'JPEG', type: 'image/jpeg', ext: 'jpg', note: 'smaller file' },
  { id: 'png', label: 'PNG', type: 'image/png', ext: 'png', note: 'lossless, larger' },
]
const LAYOUTS = [
  { id: 'scene', label: 'Scene' },
  { id: 'pair', label: 'Before and after' },
]
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {} } catch { return {} } },
  set: (v) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(v)) } catch { /* private mode */ } },
}
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`could not load ${src}`)); i.src = src })
const slugPart = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

export function mount(ctx) {
  const { engine, shell, kit } = ctx
  const { h, button, segmented } = kit
  let sheet = null

  // the sizes that make sense for this photo: Full, then the presets smaller than it
  function sizesFor() {
    const p = engine.getPhotoSize()
    const long = Math.max(p.w, p.h)
    return SIZES.filter((s) => !s.long || s.long < long)
  }
  function dimsFor(sizeId) {
    const p = engine.getPhotoSize()
    const s = SIZES.find((x) => x.id === sizeId) || SIZES[0]
    const k = s.long ? Math.min(1, s.long / Math.max(p.w, p.h)) : 1
    return { w: Math.max(1, Math.round(p.w * k)), h: Math.max(1, Math.round(p.h * k)), long: s.long }
  }
  const pairShape = (w, h) => (w >= h ? { w, h: h * 2, stacked: true } : { w: w * 2, h, stacked: false })
  function fileName(o, w, h) {
    const sc = engine.getScene()
    const parts = [slugPart(sc?.title) || sc?.name || 'scene', slugPart(engine.getLayoutTitle?.()) || null, o.layout === 'pair' ? 'before-after' : null, `${w}x${h}`]
    return `${parts.filter(Boolean).join('-')}.${FORMATS.find((f) => f.id === o.format)?.ext || 'jpg'}`
  }

  // → { blob, name, width, height } for options { size, format, layout, quality }
  async function exportNow(opts = {}) {
    const o = { size: 'full', format: 'jpeg', layout: 'scene', quality: 0.92, ...opts }
    const fmt = FORMATS.find((f) => f.id === o.format) || FORMATS[0]
    const { long } = dimsFor(o.size)
    if (o.layout !== 'pair') {
      const r = await engine.exportImage({ longEdge: long, type: fmt.type, quality: o.quality })
      return { blob: r.blob, name: fileName(o, r.width, r.height), width: r.width, height: r.height }
    }
    const [r, photo] = await Promise.all([
      engine.exportImage({ longEdge: long, encode: false }),
      loadImage(engine.getScene()?.photo_url).catch((e) => { throw engine.reportError('Could not load the photo for Before and after', e) }),
    ])
    const { w, h } = { w: r.width, h: r.height }
    const pair = pairShape(w, h)
    const c = document.createElement('canvas')
    c.width = pair.w
    c.height = pair.h
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(photo, 0, 0, w, h)
    g.drawImage(r.canvas, pair.stacked ? 0 : w, pair.stacked ? h : 0)
    // small "Before" / "After" tags in each half's top-left corner
    const fs = Math.max(12, Math.round(Math.max(w, h) * 0.022))
    g.font = `600 ${fs}px system-ui, -apple-system, sans-serif`
    g.textBaseline = 'middle'
    for (const [text, x, y] of [['Before', 0, 0], ['After', pair.stacked ? 0 : w, pair.stacked ? h : 0]]) {
      const pad = Math.round(fs * 0.6), tw = g.measureText(text).width
      const bx = x + pad, by = y + pad, bw = tw + pad * 2, bh = fs + pad
      g.fillStyle = 'rgba(14, 15, 17, 0.72)'
      g.beginPath()
      if (g.roundRect) g.roundRect(bx, by, bw, bh, bh / 2); else g.rect(bx, by, bw, bh)
      g.fill()
      g.fillStyle = '#ECE8E0'
      g.fillText(text, bx + pad, by + bh / 2)
    }
    const blob = await new Promise((res) => c.toBlob(res, fmt.type, fmt.type === 'image/jpeg' ? o.quality : undefined))
    if (!blob) throw engine.reportError('Could not encode the image')
    return { blob, name: fileName(o, c.width, c.height), width: c.width, height: c.height }
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: name, hidden: true })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  function open() {
    if (!engine.getSceneName() || engine.getSceneLoad().loading) { shell.toast('Open a scene first.', { id: 'no-scene' }); return }
    if (sheet?.isOpen()) return
    const sizes = sizesFor()
    const pref = store.get()
    const o = {
      size: sizes.some((s) => s.id === pref.size) ? pref.size : 'full',
      format: FORMATS.some((f) => f.id === pref.format) ? pref.format : 'jpeg',
      layout: LAYOUTS.some((l) => l.id === pref.layout) ? pref.layout : 'scene',
    }
    let busy = false
    let preview = null
    try { preview = engine.captureComposite({ maxPx: 720, quality: 0.8 }) } catch (e) { engine.reportError('Could not capture the scene', e); return }
    const phone = shell.isPhone()
    const remember = () => store.set(o)

    const img = h('img', { src: preview.dataUrl, alt: 'The scene as it will be saved' })
    const before = h('img.ex-before', { src: engine.getScene()?.photo_url, alt: 'The photo' })
    const pv = h('div.ex-preview', before, img)
    const info = h('p.ex-info.tnum')
    const go = button({ label: 'Save image', kind: 'primary', block: phone, onClick: () => quiet(run('save')) })
    go.classList.add('ms-primary')
    go.dataset.midstudy = 'export-go'
    const canShare = phone && typeof navigator.canShare === 'function' && (() => { try { return navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }) } catch { return false } })()
    const share = canShare ? button({ label: 'Share…', kind: 'secondary', onClick: () => quiet(run('share')) }) : null
    function sync() {
      const d = dimsFor(o.size)
      const out = o.layout === 'pair' ? pairShape(d.w, d.h) : d
      const fmt = FORMATS.find((f) => f.id === o.format)
      info.textContent = `${out.w} × ${out.h} ${fmt.label} · ${fmt.note}`
      pv.dataset.layout = o.layout
      pv.dataset.shape = d.w >= d.h ? 'wide' : 'tall'
      go.disabled = busy
      if (share) share.disabled = busy
      go.lastChild.textContent = busy ? 'Saving…' : 'Save image'
    }
    const row = (label, control) => h('div.ms-row', h('span.ms-label', label), control)
    const seg = (opts, key) => {
      const s = segmented(opts.map((x) => ({ value: x.id, label: x.label })), o[key], (v) => { o[key] = v; remember(); sync() }, { label: key })
      s.classList.add('ms-seg')
      s.dataset.midstudy = `export-${key}`
      return s
    }
    const fullDims = dimsFor('full')
    const sizeOpts = sizes.map((s) => (s.id === 'full' ? { ...s, label: `Full · ${fullDims.w} × ${fullDims.h}` } : s))
    const body = h('div.ms-form.ex',
      pv,
      row('Size', seg(sizeOpts, 'size')),
      row('Format', seg(FORMATS, 'format')),
      row('Picture', seg(LAYOUTS, 'layout')),
      info,
      h('p.ms-note', ctx.icons.icon('info', { size: 14 }), h('span', 'The view as drawn here, without AI: free, and nothing leaves this device. For a photoreal image, use Render.')))

    async function run(how) {
      if (busy) return
      busy = true
      sync()
      try {
        const r = await exportNow(o)
        if (how === 'share') {
          const file = new File([r.blob], r.name, { type: r.blob.type })
          try { await navigator.share({ files: [file], title: r.name }) } catch (e) { if (e?.name !== 'AbortError') throw e }
        } else {
          save(r.blob, r.name)
          shell.toast(`Saved ${r.name}`, { kind: 'ok', id: 'export-saved', ms: 5000 })
        }
        sheet?.close()
      } catch (e) {
        if (!engine.errors.includes(e?.message)) engine.reportError('Export failed', e)
      } finally {
        busy = false
        if (sheet?.isOpen()) sync()
      }
    }
    sheet = openSheet(shell, {
      title: 'Export image', sub: 'Free · no AI', label: 'Export image', cls: 'ex-sheet', body,
      actions: [phone ? null : button({ label: 'Cancel', kind: 'secondary', onClick: () => sheet?.close() }), share, go],
      onClose: () => { sheet = null },
    })
    sync()
  }

  ctx.exporter = { open, exportNow }
}
