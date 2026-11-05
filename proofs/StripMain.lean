import Midstudy.Jpeg.Model
import Midstudy.Png
import Midstudy.Slug
import Midstudy.Jpeg.Frame

/-!
`lake exe mediastrip jpeg|png|slug LIST OUTDIR`: the proved models of the JPEG and PNG strippers
(`Midstudy.Jpeg.strip`, `isClean`; `Midstudy.Png.strip`) and of `is_slug` as a program, for comparing with the Rust
(`core/crates/media/src/{jpeg,png,slug}.rs`) on the same files (`proofs/diff/`). For each path in LIST (one per line)
it prints `name<TAB>ok<TAB>length<TAB>clean` (and writes the stripped bytes to OUTDIR/name) or
`name<TAB>err<TAB>Kind<TAB>clean`, where `clean` is the JPEG `isClean` of the input (`-` for PNG); for `slug`,
`name<TAB>res<TAB>true|false<TAB>-` (the file's bytes are the string); for `frame` (jpeg.rs `frame_info`),
`name<TAB>res<TAB>width,height,components,precision,marker<TAB>-` or `name<TAB>err<TAB>Kind<TAB>-`.
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

/-- One file: the stripped bytes or the error's name, and the `clean` column. -/
def run (mode : String) (data : List UInt8) : Except String (List UInt8) × String :=
  if mode == "jpeg" then
    ((Midstudy.Jpeg.strip data).mapError jpegErr, toString (Midstudy.Jpeg.isClean data))
  else ((Midstudy.Png.strip data).mapError pngErr, "-")

def main (args : List String) : IO UInt32 := do
  match args with
  | [mode, list, outDir] =>
    if mode != "jpeg" && mode != "png" && mode != "slug" && mode != "frame" then
      IO.eprintln "mode must be jpeg, png, slug or frame"
      return 2
    let paths := ((← IO.FS.readFile list).splitOn "\n").filter (· ≠ "")
    IO.FS.createDirAll outDir
    for path in paths do
      let data := (← IO.FS.readBinFile path).toList
      let name := (System.FilePath.mk path).fileName.getD path
      if mode == "slug" then
        IO.println s!"{name}\tres\t{Midstudy.Slug.isSlug data}\t-"
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
    IO.eprintln "usage: mediastrip jpeg|png|slug|frame LIST OUTDIR"
    return 2
