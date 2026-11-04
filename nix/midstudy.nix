# midstudy's web app: the planner (planner/, no build step) and its server (planner/serve.py, stdlib Python only).
# The server runs library jobs with midstudy-add (contract §2.8) and scene calibration and keep-room alignment with
# midstudy-calib (§4.3, §4.4, §4.7): the wrapper passes both as store paths, so nothing needs uv or the repo.
#
# serve.py serves the folder above planner/ (its REPO) as the static root, so the package keeps that layout under
# share/midstudy with planner/ alone in it: nothing else is servable. The data folders (scenes, library, layouts,
# renders) must be passed as absolute paths: serve.py resolves relative ones against REPO, which is read-only here.
#   midstudy-web --port 8780 --scenes-dir /srv/m/scenes --library-dir /srv/m/library \
#     --layouts-dir /srv/m/layouts --renders-dir /srv/m/renders [--allowed-host NAME] [--daily-spend-usd 2]
# Flags given after the wrapper's own win (argparse keeps the last), so --calib can still be replaced, e.g. by the
# NixOS module's device-pinning shim.
{
  lib,
  stdenvNoCC,
  python3,
  makeWrapper,
  midstudy-add,
  midstudy-calib,
}:
stdenvNoCC.mkDerivation {
  pname = "midstudy";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = ../planner;
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  # -I: serve.py imports only the standard library; keep the environment's PYTHONPATH and the cwd out of it.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/midstudy $out/bin
    cp -r planner $out/share/midstudy/
    makeWrapper ${python3}/bin/python3 $out/bin/midstudy-web \
      --add-flags "-I $out/share/midstudy/planner/serve.py" \
      --add-flags "--calib ${lib.getExe midstudy-calib} --midstudy-add ${lib.getExe midstudy-add}"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/midstudy-web --help >/dev/null
    runHook postInstallCheck
  '';

  passthru = { inherit midstudy-add midstudy-calib; };

  meta = {
    description = "midstudy: place real-size 3D furniture on a phone photo of a room (web app and server)";
    mainProgram = "midstudy-web";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
