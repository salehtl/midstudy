import Midstudy.Jpeg.Model

/-!
`lake exe jpegstrip LIST OUTDIR`: the proved model of the JPEG stripper (`Midstudy.Jpeg.strip`, `isClean`) as a
program, for comparing with the Rust (`core/crates/media/src/jpeg.rs`) on the same files (`proofs/diff/`). For each
path in LIST (one per line) it prints `name<TAB>ok<TAB>length<TAB>clean` (and writes the stripped bytes to
OUTDIR/name) or `name<TAB>err<TAB>Kind<TAB>clean`, where `clean` is `isClean` of the input.
-/

open Midstudy.Jpeg

def errName : Err → String
  | .notJpeg => "NotJpeg"
  | .expectedMarker => "ExpectedMarker"
  | .badMarker => "BadMarker"
  | .badLength => "BadLength"
  | .truncated => "Truncated"
  | .noEndOfImage => "NoEndOfImage"

def main (args : List String) : IO UInt32 := do
  match args with
  | [list, outDir] =>
    let paths := ((← IO.FS.readFile list).splitOn "\n").filter (· ≠ "")
    IO.FS.createDirAll outDir
    for path in paths do
      let data := (← IO.FS.readBinFile path).toList
      let name := (System.FilePath.mk path).fileName.getD path
      let clean := isClean data
      match strip data with
      | .ok out =>
        IO.FS.writeBinFile (System.FilePath.mk outDir / name) ⟨out.toArray⟩
        IO.println s!"{name}\tok\t{out.length}\t{clean}"
      | .error e => IO.println s!"{name}\terr\t{errName e}\t{clean}"
    return 0
  | _ =>
    IO.eprintln "usage: jpegstrip LIST OUTDIR"
    return 2
