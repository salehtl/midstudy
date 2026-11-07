// Render (contract §2.6, §4.7, §4.9 `room`): v1's post_render checks (planner/serve.py), in v1's order and with its sentences,
// then server/src/scenes/render.ts (the spend cap through deps.spend, fal through common/fal.ts, cost rows through
// common/costs.ts, align one-shot through server/src/tools.ts); and list_renders. The patterns are v1's.
import fs from 'node:fs'
import path from 'node:path'
import { falMock } from '../../../common/fal.ts'
import { decodeImageDataUri, jpegFrame, pngSize, stripJpeg } from '../../../core/js/node.ts'
import type { RequestContext } from '../http/context.ts'
import type { RouteModule } from '../http/router.ts'
import { isFile } from '../../../common/files.ts'
import type { RenderService } from '../scenes/render.ts'
import {
  KEEP_ROOM_NEEDS_MASK, KEEP_ROOM_NEEDS_SCENE, NOT_JPEG_URI, NO_FRAME, NO_PHOTO_YET, maskSizeProblem, modelChoice, renderLayout, renderPrice, takesReference,
  renderPrompt, upscaleScale,
} from '../scenes/logic/render.ts'
import { noScene } from '../scenes/logic/scene.ts'
import { isRecord } from '../scenes/logic/values.ts'
import type { SceneService } from '../scenes/service.ts'
import { RENDER_ROOM_NEEDS_SCENE, noRoom, renderSceneNotMember } from '../rooms/logic/room.ts'
import type { RoomService } from '../rooms/service.ts'
import { scenesFor } from '../scenes/shared.ts'

/** The bytes of a data URI of `type`, or null (v1 `decode_data_uri`: anything but such a string is None). */
function dataUriBytes(v: unknown, type: 'jpeg' | 'png'): Uint8Array | null {
  if (typeof v !== 'string') return null
  const r = decodeImageDataUri(v, type)
  return r.ok ? r.value : null
}

/** v1 `post_render`. */
async function postRender(ctx: RequestContext, scenes: SceneService, rooms: RoomService, renders: RenderService): Promise<void> {
  const body = await ctx.readJson()
  if (!isRecord(body)) {
    await ctx.error(400, 'body must be a JSON object')
    return
  }
  // Stored, served and sent to fal: without any metadata the client's JPEG may carry (§2.6, privacy).
  const raw = dataUriBytes(body['image'], 'jpeg')
  const clean = raw !== null && raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff ? stripJpeg(raw) : null
  if (clean?.ok !== true || clean.value.bytes.length === 0) {
    await ctx.error(400, NOT_JPEG_URI)
    return
  }
  const image = clean.value.bytes
  const choice = modelChoice(body['model'])
  if (choice.kind !== 'model') {
    await ctx.error(choice.kind === 'refused' ? 400 : 500, choice.error)
    return
  }
  const prompt = body['prompt']
  if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') {
    await ctx.error(400, 'prompt must be a string')
    return
  }
  const sceneValue = body['scene']
  if (sceneValue !== undefined && sceneValue !== null && (typeof sceneValue !== 'string' || !scenes.exists(sceneValue))) {
    await ctx.error(404, noScene(typeof sceneValue === 'string' ? sceneValue : ''))
    return
  }
  const scene = typeof sceneValue === 'string' ? sceneValue : null
  // §4.9: a render made in a room names it; the capture, reference and keep-room stay that photo's.
  const roomValue = body['room']
  let room: string | null = null
  if (roomValue !== undefined && roomValue !== null) {
    if (typeof roomValue !== 'string' || !rooms.exists(roomValue)) {
      await ctx.error(404, noRoom(typeof roomValue === 'string' ? roomValue : ''))
      return
    }
    if (scene === null) {
      await ctx.error(400, RENDER_ROOM_NEEDS_SCENE)
      return
    }
    if (!(rooms.read(roomValue)?.members ?? []).some((m) => m.scene === scene)) {
      await ctx.error(400, renderSceneNotMember(scene, roomValue))
      return
    }
    room = roomValue
  }
  const layout = renderLayout(body['layout'])
  const keepRoom = body['keep_room'] === true
  let photo: Buffer | null = null
  if (scene !== null) {
    const photoPath = path.join(scenes.path(scene), 'photo.jpg')
    if (!isFile(photoPath)) {
      await ctx.error(409, NO_PHOTO_YET)
      return
    }
    photo = fs.readFileSync(photoPath)
  }
  let mask: Uint8Array | null = null
  if (keepRoom) {
    if (scene === null || photo === null) {
      await ctx.error(400, KEEP_ROOM_NEEDS_SCENE)
      return
    }
    mask = dataUriBytes(body['mask'], 'png')
    const maskSize = mask === null || mask.length === 0 ? null : pngSize(mask)
    if (maskSize === null) {
      await ctx.error(400, KEEP_ROOM_NEEDS_MASK)
      return
    }
    const photoSize = jpegFrame(photo)
    const problem = maskSizeProblem(maskSize.width, maskSize.height, photoSize.ok ? photoSize.value.width : null, photoSize.ok ? photoSize.value.height : null)
    if (problem !== null) {
      await ctx.error(400, problem)
      return
    }
  }
  const reference = takesReference(choice.model) && photo !== null
  const size = jpegFrame(image)
  if (!size.ok) {
    // The price can depend on the size (qwen: $0.03 a megapixel), so a composite whose frame header can't be read isn't
    // guessed at 1 MP against the cap: it is refused (§2.6, §2.9).
    await ctx.error(400, NO_FRAME)
    return
  }
  const { width, height } = size.value
  const outcome = await renders.render({
    image, width, height, model: choice.model, prompt: renderPrompt(typeof prompt === 'string' ? prompt : null, reference, choice.model === 'gpt-image' && scene !== null), scene, layout, room,
    reference: reference ? photo : null, keepRoom, mask, price: renderPrice(choice.model, width, height),
  })
  switch (outcome.kind) {
    case 'done':
      await ctx.send(200, outcome.meta)
      return
    case 'refused':
      await ctx.send(402, outcome.body)
      return
    case 'error':
      await ctx.error(outcome.status, outcome.error)
      return
  }
}

/** §4.7 Upscale: `POST /api/renders/<name>/upscale` with `{scale?: 2 | 4}`. */
async function postUpscale(ctx: RequestContext, renders: RenderService, name: string): Promise<void> {
  const body = await ctx.readJson()
  if (!isRecord(body)) {
    await ctx.error(400, 'body must be a JSON object')
    return
  }
  const choice = upscaleScale(body['scale'])
  if (choice.kind !== 'scale') {
    await ctx.error(400, choice.error)
    return
  }
  const outcome = await renders.upscale(name, choice.scale)
  switch (outcome.kind) {
    case 'done':
      await ctx.send(200, outcome.meta)
      return
    case 'refused':
      await ctx.send(402, outcome.body)
      return
    case 'error':
      await ctx.error(outcome.status, outcome.error)
      return
  }
}

export const routes: RouteModule = (deps) => {
  const { scenes, rooms, renders } = scenesFor(deps)
  return [
    { method: 'POST', path: /^\/api\/render$/, handle: (ctx) => postRender(ctx, scenes, rooms, renders) },
    { method: 'POST', path: /^\/api\/renders\/([^/]*)\/upscale$/, handle: (ctx, [name = '']) => postUpscale(ctx, renders, name) },
    {
      method: 'GET', path: /^\/api\/renders$/, handle: async (ctx) => {
        await ctx.send(200, { renders: renders.list(ctx.query('scene'), ctx.query('room')), mock: falMock() })
      },
    },
  ]
}
