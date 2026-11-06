# midstudy's web app: the server (server/src/main.ts on Node 22, contract §2.1) serving the planner bundle, from the
# built tree (nix/midstudy-app.nix: `npm ci && npm run build` in Nix, the wasm kernels included). It runs library jobs
# with midstudy-add (§2.8) and scene calibration, lighting and keep-room alignment with midstudy-calib (§4.3, §4.4,
# §4.7, §4.8); calibrations go through midstudy-calib's warm worker (`<calib> serve`, MoGe-2 loaded once, §4.3 Worker),
# which the server starts on the first job, with the one-shot commands as its fallback. The wrapper passes both tools as
# store paths, so nothing needs uv, npm or the repository at run time.
#
# The server serves the tree's planner/ and resolves relative data folders against the tree, which is read-only here,
# so pass them as absolute paths (the NixOS module does):
#   midstudy-web --port 8780 --scenes-dir /srv/m/scenes --library-dir /srv/m/library \
#     --layouts-dir /srv/m/layouts --renders-dir /srv/m/renders [--allowed-host NAME] [--daily-spend-usd 2]
# Flags given after the wrapper's own win (the last value counts, as argparse did), so --calib and --midstudy-add can
# still be replaced, e.g. by the NixOS module's device-pinning shim.
{
  lib,
  stdenvNoCC,
  makeWrapper,
  midstudy-app,
  midstudy-add,
  midstudy-calib,
}:
let
  inherit (midstudy-app) nodejs;
in
stdenvNoCC.mkDerivation {
  pname = "midstudy";
  inherit (midstudy-app) version;

  dontUnpack = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    makeWrapper ${lib.getExe nodejs} $out/bin/midstudy-web \
      --add-flags ${midstudy-app}/share/midstudy/server/src/main.ts \
      --add-flags "--calib ${lib.getExe midstudy-calib} --midstudy-add ${lib.getExe midstudy-add}"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/midstudy-web --help >/dev/null
    runHook postInstallCheck
  '';

  passthru = {
    app = midstudy-app;
    inherit midstudy-add midstudy-calib;
    inherit (midstudy-app) wasm nodeModules;
  };

  meta = {
    description = "midstudy: place real-size 3D furniture on a phone photo of a room (web app and server)";
    mainProgram = "midstudy-web";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
