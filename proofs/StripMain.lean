import Midstudy.Jpeg.Model
import Midstudy.Png
import Midstudy.Slug
import Midstudy.Jpeg.Frame
import Midstudy.Base64
import Midstudy.Sniff
import Midstudy.Wire

/-!
`lake exe mediastrip MODE LIST OUTDIR`: the proved models as a program, for comparing with the Rust on the same files
(`proofs/diff/`; `proofs/diff/src/main.rs` prints the same lines). For each path in LIST (one per line):

* `jpeg`, `png` (`Midstudy.Jpeg.strip`, `isClean`; `Midstudy.Png.strip`): `name<TAB>ok<TAB>length<TAB>clean` (and the
  stripped bytes in OUTDIR/name) or `name<TAB>err<TAB>Kind<TAB>clean`, `clean` the JPEG `isClean` of the input (`-` for
  PNG);
* `slug` (`is_slug` of the file's bytes): `name<TAB>res<TAB>true|false<TAB>-`;
* `frame` (jpeg.rs `frame_info`): `name<TAB>res<TAB>width,height,components,precision,marker<TAB>-` or
  `name<TAB>err<TAB>Kind<TAB>-`;
* `b64` (base64.rs): `name<TAB>res<TAB>STRICT|LENIENT|ENCODED<TAB>-`, the two `decode_python` results (`ok:<hex>` or
  `err:<Kind>[@offset]`) and `encode` of the file's bytes;
* `meta` (meta.rs `decode`, the file's bytes as the header): `name<TAB>res<TAB>CAP16K|CAP64<TAB>-` (`ok:<hex>`,
  `err:TooLong:<len>:<max>`, `err:NotAscii`, `err:Base64:<Kind>`, `err:NotUtf8`), or `not-utf8-input` when the
  bytes aren't a Rust `&str`;
* `sniff` (sniff.rs): `name<TAB>res<TAB>kind,photo_ext,kind<TAB>-` (the third is wasm-node's `api::sniff`);
* `wire` (wire.rs `Reader`, api.rs `zip_plan`'s loop): `name<TAB>res<TAB>n=<count>;<entries>|bad-input<TAB>ok|bad`,
  each entry `hex(name),flags,low,high,attr,utf8,size`, the last column whether `zip_plan` answers `bad-input`.
-/

def jpegErr : Midstudy.Jpeg.Err → String
  | .notJpeg => "NotJpeg"
  | .expectedMarker => "ExpectedMarker"
  | .badMarker => "BadMarker"
  | .badLength => "BadLength"
  | .truncated => "Truncated"
  | .noEndOfImage => "NoEndOfImage"

def sizeErr : Midstudy.Jpeg.SizeErr → String
  | .notJpeg => "NotJpeg"
  | .expectedMarker => "ExpectedMarker"
  | .scanBeforeFrame => "ScanBeforeFrame"
  | .endBeforeFrame => "EndBeforeFrame"
  | .truncated => "Truncated"
  | .badLength => "BadLength"
  | .zeroSize => "ZeroSize"
  | .noFrame => "NoFrame"

def pngErr : Midstudy.Png.Err → String
  | .notPng => "NotPng"
  | .truncated => "Truncated"
  | .noEnd => "NoEnd"

/-- Lowercase hex. -/
def hexOf (l : List UInt8) : String :=
  let d := "0123456789abcdef".toList
  String.ofList (l.flatMap fun b => [d.getD (b.toNat / 16) '0', d.getD (b.toNat % 16) '0'])

def b64Err : Midstudy.Base64.Err → String
  | .leadingPadding => "LeadingPadding"
  | .excessPadding => "ExcessPadding"
  | .notBase64 p => s!"NotBase64@{p}"
  | .discontinuousPadding p => s!"DiscontinuousPadding@{p}"
  | .dataAfterPadding => "DataAfterPadding"
  | .oneExtraCharacter => "OneExtraCharacter"
  | .incorrectPadding => "IncorrectPadding"

def b64Res : Except Midstudy.Base64.Err (List UInt8) → String
  | .ok b => s!"ok:{hexOf b}"
  | .error e => s!"err:{b64Err e}"

def metaRes : Except Midstudy.Base64.MetaErr (List UInt8) → String
  | .ok b => s!"ok:{hexOf b}"
  | .error (.tooLong l m) => s!"err:TooLong:{l}:{m}"
  | .error .notAscii => "err:NotAscii"
  | .error (.base64 e) => s!"err:Base64:{b64Err e}"
  | .error .notUtf8 => "err:NotUtf8"

/-- The `b64`, `meta`, `sniff` and `wire` lines' result columns. -/
def misc (mode : String) (data : List UInt8) : String × String :=
  if mode == "b64" then
    let enc := String.ofList ((Midstudy.Base64.encode data).map fun b => Char.ofNat b.toNat)
    (s!"{b64Res (Midstudy.Base64.decodePython data true)}|{b64Res (Midstudy.Base64.decodePython data false)}|{enc}",
      "-")
  else if mode == "meta" then
    if Midstudy.Base64.utf8Valid data then
      (s!"{metaRes (Midstudy.Base64.metaDecode data Midstudy.Base64.MAX_HEADER_LEN)}|" ++
        metaRes (Midstudy.Base64.metaDecode data 64), "-")
    else ("not-utf8-input", "-")
  else if mode == "sniff" then
    let k := Midstudy.Sniff.sniff data
    (s!"{k.name},{(Midstudy.Sniff.photoExt k).getD "-"},{k.name}", "-")
  else
    match Midstudy.Wire.readAll (Midstudy.Wire.Reader.new data) with
    | none => ("bad-input", "bad")
    | some es =>
      let one (e : Midstudy.Wire.Raw) : String :=
        s!";{hexOf e.name},{e.flags},{e.low},{e.high},{e.attr},{if e.utf8 then 1 else 0},{e.size}"
      (s!"n={es.length}" ++ String.join (es.map one), "ok")

/-- One file: the stripped bytes or the error's name, and the `clean` column. -/
def run (mode : String) (data : List UInt8) : Except String (List UInt8) × String :=
  if mode == "jpeg" then
    ((Midstudy.Jpeg.strip data).mapError jpegErr, toString (Midstudy.Jpeg.isClean data))
  else ((Midstudy.Png.strip data).mapError pngErr, "-")

def main (args : List String) : IO UInt32 := do
  match args with
  | [mode, list, outDir] =>
    if not (["jpeg", "png", "slug", "frame", "b64", "meta", "sniff", "wire"].contains mode) then
      IO.eprintln "mode must be jpeg, png, slug, frame, b64, meta, sniff or wire"
      return 2
    let paths := ((← IO.FS.readFile list).splitOn "\n").filter (· ≠ "")
    IO.FS.createDirAll outDir
    for path in paths do
      let data := (← IO.FS.readBinFile path).toList
      let name := (System.FilePath.mk path).fileName.getD path
      if mode == "slug" then
        IO.println s!"{name}\tres\t{Midstudy.Slug.isSlug data}\t-"
        continue
      if ["b64", "meta", "sniff", "wire"].contains mode then
        let (res, last) := misc mode data
        IO.println s!"{name}\tres\t{res}\t{last}"
        continue
      if mode == "frame" then
        match Midstudy.Jpeg.frameInfo data with
        | .ok f =>
          IO.println s!"{name}\tres\t{f.width},{f.height},{f.components},{f.precision},{f.marker}\t-"
        | .error e => IO.println s!"{name}\terr\t{sizeErr e}\t-"
        continue
      match run mode data with
      | (.ok out, clean) =>
        IO.FS.writeBinFile (System.FilePath.mk outDir / name) ⟨out.toArray⟩
        IO.println s!"{name}\tok\t{out.length}\t{clean}"
      | (.error e, clean) => IO.println s!"{name}\terr\t{e}\t{clean}"
    return 0
  | _ =>
    IO.eprintln "usage: mediastrip jpeg|png|slug|frame|b64|meta|sniff|wire LIST OUTDIR"
    return 2
