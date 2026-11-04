# REFERENCE ONLY (copied from nook, renamed mechanically): still describes nook's scan trainer and web app.
# flake.nix does not use it yet. The packaging track rewrites it for midstudy (PLAN.md §9).
# nook's runtime: the web app (planner/serve.py) and nook-scan (trainer + jobs server), stdlib Python plus numpy,
# pillow and jsonschema. Keeps the repo layout under share/nook so the code finds contract/ the way it does in git.
# nook-web runs library jobs with the midstudy-add package (nix/midstudy-add.nix, contract §2.8).
{
  lib,
  stdenvNoCC,
  python3,
  makeWrapper,
  colmap,
  nook-gsplat,
  midstudy-add,
}:
let
  py = python3.withPackages (ps: [
    ps.numpy
    ps.pillow
    ps.jsonschema
  ]);
in
stdenvNoCC.mkDerivation {
  pname = "nook";
  version = "0.3.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../planner
      ../scan/src
      ../contract
    ];
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/nook $out/bin
    cp -r planner scan contract $out/share/nook/
    makeWrapper ${py}/bin/python3 $out/bin/nook-scan \
      --add-flags "-c 'from nook_scan.cli import main; main()'" \
      --set PYTHONPATH $out/share/nook/scan/src \
      --set MIDSTUDY_VERSION 0.2.0 \
      --set-default MIDSTUDY_GSPLAT_BIN ${lib.getExe nook-gsplat} \
      --set-default MIDSTUDY_COLMAP_BIN ${lib.getExe colmap}
    makeWrapper ${py}/bin/python3 $out/bin/nook-web \
      --add-flags "$out/share/nook/planner/serve.py --midstudy-add ${lib.getExe midstudy-add}"
    runHook postInstall
  '';

  meta = {
    description = "Reading-room planner, iPhone scan trainer and jobs server";
    mainProgram = "nook-scan";
    platforms = lib.platforms.linux;
  };
}
