// A raw-body add (contract §2.8 POST /api/library/items; v1 planner/serve.py `post_library_upload`): the headers, the
// file name's extension, the size limits and the sentences of every refusal, in v1's order. Pure (TScert); the route
// (server/src/routes/library.ts) reads the body and the bytes.
import { mbText, pyStrip } from '../../../../common/logic/pyfmt.ts'
import { posixName } from '../../../../common/logic/slug.ts'
import type { UploadKind } from './meta.ts'

export const KIND_REQUIRED = 'X-Midstudy-Kind must be model or image'
export const FILENAME_REQUIRED = "X-Midstudy-Filename is required (the file's name, e.g. chair.glb)"
export const META_REQUIRED = 'X-Midstudy-Meta must be base64 of a JSON object with name and dims_cm'
export const LENGTH_REQUIRED = 'Content-Length is required: send the file as the request body'
export const EMPTY_FILE = 'the file is empty'
export const STOPPED = 'the upload stopped before the end: try again'
export const NOT_IMAGE = "that file isn't a JPEG, PNG, HEIC or WebP image"
export const NOT_GLB = "that file isn't a GLB (binary glTF): export it again as .glb"
export const FROM_URL_SHAPE = 'the body must be JSON like {"image_url": "https://...", "name": ..., "dims_cm": {...}}'
export const LINK_NOT_IMAGE = "that link isn't a JPEG, PNG, HEIC or WebP image"

/** v1 MAX_MODEL and MAX_IMAGE: 200 MiB and 20 MiB. */
const MAX_MODEL = 200 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MIB = 1024 * 1024

/** X-Midstudy-Kind, stripped and lowercased: model or image, else null. */
export function uploadKind(header: string | undefined): UploadKind | null {
  const k = pyStrip(header ?? '').toLowerCase()
  return k === 'model' ? 'model' : k === 'image' ? 'image' : null
}

/** X-Midstudy-Filename's last path component (`PurePosixPath(name.replace("\\", "/")).name`): '' when there is none. */
export function uploadFilename(header: string | undefined): string {
  return posixName((header ?? '').replace(/\\/g, '/'))
}

/** `PurePosixPath(name).suffix.lower()`: the last `.ext` of the name ('' for `.glb`, `a.` or no dot). */
export function suffixOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : ''
}

/** The extensions a photo may have. */
function imageExt(ext: string): boolean {
  return ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.heic' || ext === '.heif' || ext === '.webp'
}

/** The refusal of a file name's extension, or null (models: .glb or .zip; photos: JPEG, PNG, HEIC or WebP). */
export function extProblem(kind: UploadKind, ext: string): string | null {
  if (kind === 'image') return imageExt(ext) ? null : 'a photo must be a JPEG, PNG, HEIC or WebP file'
  if (ext === '.usdz' || ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.reality') {
    return ext + " isn't supported: convert to GLB first (e.g. Reality Converter or Blender)"
  }
  if (ext === '.gltf') return 'a .gltf needs its side files: convert it to .glb first, or zip an .obj with its .mtl and textures'
  if (ext !== '.glb' && ext !== '.zip') return 'a model must be a .glb, or a .zip holding one .obj with its .mtl and textures'
  return null
}

/** The most bytes an upload of this kind may have. */
export function sizeLimit(kind: UploadKind): number {
  return kind === 'model' ? MAX_MODEL : MAX_IMAGE
}

/** The 413 sentence for a body of `length` bytes. */
export function tooLarge(kind: UploadKind, length: number): string {
  return 'that file is ' + mbText(length) + ': ' + (kind === 'model' ? 'models' : 'photos') + ' can be at most ' + String(Math.floor(sizeLimit(kind) / MIB)) + ' MB'
}

/** v1 `zip_problem`'s sentence for a zip its reader refused. */
export function unreadableZip(reason: string): string {
  return "that isn't a readable zip (" + reason + ')'
}
