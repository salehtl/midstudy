// Render (contract §2.6, §4.7): v1's post_render, render, align and list_renders (planner/serve.py). A paid fal image
// edit of the capture (with the scene photo as image 2 for nano-banana), reserved against the daily cap first; in mock
// mode the result is the capture itself, $0. Keep-room writes the raw output and runs `<calib> align` one-shot (never
// through the calibration worker, so a render never waits behind a calibration).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendCost } from '../../../common/costs.ts'
import { FalError, NO_KEY, download, falCall, falKey, falMock, mockCost } from '../../../common/fal.ts'
import type { JsonLineValue } from '../../../common/logic/jsonline.ts'
import { isoUtc, isoUtcMs } from '../../../common/logic/time.ts'
import { isRenderName, jpegFrame } from '../../../core/js/node.ts'
import type { SpendCap, SpendRefusal } from '../spend.ts'
import { conformance } from '../strict.ts'
import { lastJsonLine, runTool, toolError } from '../../../common/tools.ts'
import { listDir, readJson, writeBytesSync, writeJsonSync } from './files.ts'
import { exists, isFile, removeTree, replace, resolvePath } from '../../../common/files.ts'
import { notInstalled } from './logic/jobs.ts'
import { compareRenders, numbered, renderBase } from './logic/names.ts'
import {
  UPSCALE_ENDPOINT, UPSCALE_NO_SIZE, alignFailed, alignResult, alignTimedOut, alreadyUpscaling, downloadFailed, modelSpec, noImage, noRender,
  renderMeta, resultUrl, upscaleInfo, upscalePrice, type AlignResult, type RenderMeta, type RenderModel, type UpscaleScale,
} from './logic/render.ts'
import { isRecord, pyStr } from './logic/values.ts'
import { calibResultSchema } from './logic/worker.ts'

/** v1 ALIGN_TIMEOUT: one keep-room align, 180 s. */
const ALIGN_TIMEOUT_SECONDS = 180

/** A render request that passed v1's checks. */
export interface RenderJob {
  /** The capture without its metadata. */
  readonly image: Uint8Array
  readonly width: number
  readonly height: number
  readonly model: RenderModel
  readonly prompt: string
  readonly scene: string | null
  readonly layout: string | null
  /** The room the render was made in (§4.9), or null; `scene` is then one of its photos. Absent: null. */
  readonly room?: string | null
  /** The scene photo, sent as image 2 (nano-banana or gpt-image with a scene), or null. */
  readonly reference: Uint8Array | null
  readonly keepRoom: boolean
  /** The keep-room mask (PNG), or null. */
  readonly mask: Uint8Array | null
  readonly price: number
}

/** What a render came to: its metadata, a 402, or v1's 502/503 sentence. */
export type RenderOutcome =
  | { readonly kind: 'done'; readonly meta: RenderMeta }
  | { readonly kind: 'refused'; readonly body: SpendRefusal }
  | { readonly kind: 'error'; readonly status: number; readonly error: string }

/** What an upscale came to (§4.7 Upscale): the render's meta with `upscaled`, a 402, or an error with its status. */
export type UpscaleOutcome =
  | { readonly kind: 'done'; readonly meta: Readonly<Record<string, unknown>> }
  | { readonly kind: 'refused'; readonly body: SpendRefusal }
  | { readonly kind: 'error'; readonly status: number; readonly error: string }

/** How the render reaches fal: common/fal.ts (the environment's mock switch and key, https://fal.run). Tests give a
 *  stand-in so the billed path (cost rows, 502s) runs offline without a key in the environment. */
export interface FalAccess {
  /** MIDSTUDY_FAL_MOCK is set: no network calls, the capture is the result. */
  readonly mock: () => boolean
  /** Mock calls count at their price (MIDSTUDY_FAL_MOCK_COST=1, evals only). */
  readonly mockCost: () => boolean
  /** The key for a live call, or null (503). */
  readonly key: () => string | null
  readonly call: (endpoint: string, args: JsonLineValue, key: string) => Promise<unknown>
  readonly download: (url: string) => Promise<Uint8Array>
}

export interface RenderServiceOptions {
  readonly rendersDir: string
  readonly costsFile: string
  readonly repo: string
  /** --calib, split (for align). */
  readonly calib: readonly string[]
  readonly spend: SpendCap
  /** The scene photo of `scene`: <scenes>/<scene>/photo.jpg. */
  readonly scenePhoto: (scene: string) => string
  readonly now?: () => number
  /** Tests only; default common/fal.ts. */
  readonly fal?: FalAccess
}

/** Python's `'<type>' object has no attribute 'startswith'` for a result URL that isn't text (v1's download crashed). */
function notTextUrl(url: unknown): string {
  const type = typeof url === 'number' ? (Number.isInteger(url) ? 'int' : 'float') : url === true || url === false ? 'bool' : Array.isArray(url) ? 'list' : isRecord(url) ? 'dict' : 'NoneType'
  return "'" + type + "' object has no attribute 'startswith'"
}

function dataUri(bytes: Uint8Array): string {
  return 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64')
}

export class RenderService {
  readonly dir: string
  readonly #options: RenderServiceOptions
  readonly #now: () => number
  readonly #fal: FalAccess
  /** Names given to renders still being made (v1 `reserved_names`): a name stays taken after a failure. */
  readonly #reserved = new Set<string>()
  /** Renders being upscaled now (one upscale per render at a time). */
  readonly #upscaling = new Set<string>()

  constructor(options: RenderServiceOptions) {
    this.dir = options.rendersDir
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#fal = options.fal ?? {
      mock: () => falMock(),
      mockCost: () => mockCost(),
      key: () => falKey(options.repo),
      call: (endpoint, args, key) => falCall(endpoint, args, key),
      download: (url) => download(url),
    }
  }

  /** v1 `reserve_render_name`: `render-YYYYMMDD-HHMMSS`, `-2`, `-3`… past names reserved or with any file. */
  #reserveName(now: number): string {
    const base = renderBase(now)
    let n = 1
    let name = base
    while (this.#reserved.has(name) || ['.jpg', '-input.jpg', '-raw.jpg', '-upscaled.jpg', '.json'].some((x) => exists(path.join(this.dir, name + x)))) {
      n += 1
      name = numbered(base, n)
    }
    this.#reserved.add(name)
    return name
  }

  /** v1 `post_render` from the spend cap on: reserves the price (mock calls count only with MIDSTUDY_FAL_MOCK_COST=1),
   *  renders, releases. The checks before it are the handler's. */
  async render(job: RenderJob): Promise<RenderOutcome> {
    const mock = this.#fal.mock()
    const key = mock ? null : this.#fal.key()
    if (!mock && key === null) return { kind: 'error', status: 503, error: NO_KEY }
    const now = this.#now()
    const name = this.#reserveName(now)
    const refused = this.#options.spend.reserve(name, !mock || this.#fal.mockCost() ? job.price : 0)
    if (refused !== null) {
      this.#reserved.delete(name)
      return { kind: 'refused', body: refused }
    }
    try {
      return await this.#make(job, mock, key, now, name)
    } finally {
      this.#options.spend.release(name)
    }
  }

  async #make(job: RenderJob, mock: boolean, key: string | null, now: number, name: string): Promise<RenderOutcome> {
    let cost = mock && this.#fal.mockCost() ? job.price : 0
    const stamp = isoUtc(now)
    const spec = modelSpec(job.model)
    const engine = 'render:' + job.model
    const input = job.scene ?? ''
    let result: Uint8Array
    if (mock || key === null) {
      result = job.image // mock: the "render" is the capture, $0 (its price with MIDSTUDY_FAL_MOCK_COST=1), no network
    } else {
      const image = spec.imageKey === 'image_urls'
        ? [dataUri(job.image), ...(job.reference === null ? [] : [dataUri(job.reference)])]
        : dataUri(job.image)
      const args = { [spec.imageKey]: image, prompt: job.prompt, output_format: 'jpeg', ...spec.extra }
      let answer: unknown
      try {
        answer = await this.#fal.call(spec.endpoint, args, key)
      } catch (e) {
        if (e instanceof FalError) return { kind: 'error', status: 502, error: e.message }
        throw e
      }
      // fal has answered, so the call is billed: record it even if the download below fails.
      cost = job.price
      await appendCost(this.#options.costsFile, { date: stamp, id: name, engine, costUsd: cost, mock: false, input }, 'midstudy server')
      const url = resultUrl(answer)
      if (url === null) return { kind: 'error', status: 502, error: noImage(spec.endpoint, cost) }
      try {
        if (typeof url !== 'string') throw new Error(notTextUrl(url))
        result = await this.#fal.download(url)
      } catch (e) {
        return { kind: 'error', status: 502, error: downloadFailed(e instanceof Error ? e.message : String(e), cost) }
      }
    }
    writeBytesSync(path.join(this.dir, name + '-input.jpg'), job.image)
    let aligned: AlignResult | null = null
    if (job.keepRoom && job.scene !== null && job.mask !== null) {
      writeBytesSync(path.join(this.dir, name + '-raw.jpg'), result)
      aligned = await this.#align(job.scene, name, job.mask)
      if (!aligned.applied) writeBytesSync(path.join(this.dir, name + '.jpg'), result)
    } else {
      writeBytesSync(path.join(this.dir, name + '.jpg'), result)
    }
    const final = fs.readFileSync(path.join(this.dir, name + '.jpg'))
    const out = jpegFrame(final)
    const base = renderMeta({
      name, model: job.model, cost, mock, prompt: job.prompt, created: isoUtcMs(now), scene: job.scene, layout: job.layout,
      reference: job.reference !== null, keepRoom: job.keepRoom, aligned, width: job.width, height: job.height,
      outW: out.ok ? out.value.width : null, outH: out.ok ? out.value.height : null,
    })
    const room = job.room ?? null
    const meta: RenderMeta = room === null ? base : { ...base, room }
    writeJsonSync(path.join(this.dir, name + '.json'), meta, 'midstudy/api/render-meta.schema.json')
    if (mock) await appendCost(this.#options.costsFile, { date: stamp, id: name, engine, costUsd: cost, mock: true, input }, 'midstudy server')
    this.#reserved.delete(name) // the files now hold the name; after a failure it stays reserved
    return { kind: 'done', meta }
  }

  /** §4.7 Upscale: render `name` through crystal-upscaler at `scale`, reserved against the cap first (its key is
   *  `<name>-upscale`); writes `<name>-upscaled.jpg` and the meta's `upscaled`. Mock: a copy of the render, $0. */
  async upscale(name: string, scale: UpscaleScale): Promise<UpscaleOutcome> {
    const metaPath = path.join(this.dir, name + '.json')
    const jpgPath = path.join(this.dir, name + '.jpg')
    const stored = isRenderName(name) ? readJson(metaPath) : null
    if (!isRecord(stored) || !isFile(jpgPath)) return { kind: 'error', status: 404, error: noRender(name) }
    if (this.#upscaling.has(name)) return { kind: 'error', status: 409, error: alreadyUpscaling(name) }
    const render = fs.readFileSync(jpgPath)
    const size = jpegFrame(render)
    if (!size.ok) return { kind: 'error', status: 400, error: UPSCALE_NO_SIZE }
    const price = upscalePrice(size.value.width, size.value.height, scale)
    const mock = this.#fal.mock()
    const key = mock ? null : this.#fal.key()
    if (!mock && key === null) return { kind: 'error', status: 503, error: NO_KEY }
    const hold = name + '-upscale'
    const refused = this.#options.spend.reserve(hold, !mock || this.#fal.mockCost() ? price : 0)
    if (refused !== null) return { kind: 'refused', body: refused }
    this.#upscaling.add(name)
    try {
      const now = this.#now()
      const stamp = isoUtc(now)
      const engine = 'upscale:crystal'
      const input = typeof stored['scene'] === 'string' ? stored['scene'] : ''
      let cost = mock && this.#fal.mockCost() ? price : 0
      let result: Uint8Array
      if (mock || key === null) {
        result = render
      } else {
        let answer: unknown
        try {
          answer = await this.#fal.call(UPSCALE_ENDPOINT, { image_url: dataUri(render), scale_factor: scale, output_format: 'jpg' }, key)
        } catch (e) {
          if (e instanceof FalError) return { kind: 'error', status: 502, error: e.message }
          throw e
        }
        cost = price
        await appendCost(this.#options.costsFile, { date: stamp, id: name, engine, costUsd: cost, mock: false, input }, 'midstudy server')
        const url = resultUrl(answer)
        if (url === null) return { kind: 'error', status: 502, error: noImage(UPSCALE_ENDPOINT, cost) }
        try {
          if (typeof url !== 'string') throw new Error(notTextUrl(url))
          result = await this.#fal.download(url)
        } catch (e) {
          return { kind: 'error', status: 502, error: downloadFailed(e instanceof Error ? e.message : String(e), cost) }
        }
      }
      writeBytesSync(path.join(this.dir, name + '-upscaled.jpg'), result)
      const out = jpegFrame(result)
      const upscaled = upscaleInfo(name, scale, cost, mock, isoUtcMs(now), out.ok ? out.value.width : null, out.ok ? out.value.height : null)
      const meta: Readonly<Record<string, unknown>> = { ...stored, upscaled }
      writeJsonSync(metaPath, meta, 'midstudy/api/render-meta.schema.json')
      if (mock) await appendCost(this.#options.costsFile, { date: stamp, id: name, engine, costUsd: cost, mock: true, input }, 'midstudy server')
      return { kind: 'done', meta }
    } finally {
      this.#upscaling.delete(name)
      this.#options.spend.release(hold)
    }
  }

  /** v1 `align` (keep room exact, §4.7): `<calib> align <scene photo.jpg> <name>-raw.jpg <mask.png> --out <tmp name>`;
   *  the tool's output is renamed to <name>.jpg only when it applied. Any failure is "not applied", with the reason. */
  async #align(scene: string, name: string, mask: Uint8Array): Promise<AlignResult> {
    const photo = resolvePath(this.#options.scenePhoto(scene))
    const raw = resolvePath(path.join(this.dir, name + '-raw.jpg'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midstudy-align-'))
    const out = path.join(this.dir, '.' + name + '.aligned.jpg')
    try {
      fs.writeFileSync(path.join(tmp, 'mask.png'), mask)
      const argv = [...this.#options.calib, 'align', photo, raw, path.join(tmp, 'mask.png'), '--out', resolvePath(out)]
      const run = await runTool(argv, { cwd: this.#options.repo, timeoutMs: ALIGN_TIMEOUT_SECONDS * 1000 })
      if (run.kind === 'not-found') return alignFailed(notInstalled(run.command))
      if (run.kind === 'timeout') return alignFailed(alignTimedOut(ALIGN_TIMEOUT_SECONDS))
      if (run.kind === 'spawn-error') throw new Error(run.message)
      const res = lastJsonLine(run.stdout)
      if (isRecord(res)) {
        const v = conformance(calibResultSchema('align', res['ok'] === true), res, 'midstudy-calib align result (' + name + ')')
        if (v !== null) return alignFailed(v.message + ' (' + v.detail + ')')
      }
      if (run.returnCode !== 0 || !isRecord(res) || res['ok'] !== true) {
        return alignFailed(toolError(isRecord(res) ? res['error'] : undefined, run.stderr, run.returnCode, 'midstudy-calib align'))
      }
      const wrote = res['applied'] === true && isFile(out)
      if (wrote) replace(out, path.join(this.dir, name + '.jpg'))
      return alignResult(res, wrote)
    } finally {
      removeTree(tmp)
      try {
        fs.rmSync(out, { force: true })
      } catch {
        // v1: `except OSError: pass`
      }
    }
  }

  /** v1 `list_renders`: every `render-*.json` (a render name) that parses to an object, of `scene` when given, made in
   *  `room` when given (§4.9), newest first. */
  list(scene: string | null, room: string | null = null): unknown[] {
    const out: { readonly meta: Readonly<Record<string, unknown>>; readonly created: string; readonly name: string }[] = []
    for (const f of listDir(this.dir)) {
      if (!f.startsWith('render-') || !f.endsWith('.json')) continue
      if (!isRenderName(f.slice(0, -'.json'.length))) continue
      const meta = readJson(path.join(this.dir, f))
      if (!isRecord(meta)) continue
      if (scene !== null && meta['scene'] !== scene) continue
      if (room !== null && meta['room'] !== room) continue
      const created = meta['created']
      const nameValue = meta['name']
      out.push({ meta, created: created === undefined ? '' : pyStr(created), name: nameValue === undefined ? '' : pyStr(nameValue) })
    }
    return out.sort((a, b) => compareRenders(a, b)).map((x) => x.meta)
  }
}
