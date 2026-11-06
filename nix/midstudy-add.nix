# midstudy-add: a furniture photo or model to a normalized library item (pipeline/, contract §3) as one executable:
# Node 22 running pipeline/src/cli.ts from the built tree (nix/midstudy-app.nix), with the wasm kernels (splats, images)
# and the npm packages it loads (glTF-Transform, fflate, libheif-js, obj2gltf). The server runs it for library jobs
# (§2.8) with --library <library-dir>; by hand, pass --library too (without it the CLI writes to the tree's library/,
# which is read-only here). FAL_KEY comes from the environment (services.midstudy.falKeyFile); there is no .env in the
# store. Platform-independent: built and run on the Mac (aarch64-darwin), the same files on homeserver (x86_64-linux).
{
  lib,
  stdenvNoCC,
  makeWrapper,
  midstudy-app,
}:
let
  inherit (midstudy-app) nodejs;
in
stdenvNoCC.mkDerivation {
  pname = "midstudy-add";
  inherit (midstudy-app) version;

  dontUnpack = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    makeWrapper ${lib.getExe nodejs} $out/bin/midstudy-add \
      --add-flags ${midstudy-app}/share/midstudy/pipeline/src/cli.ts
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/midstudy-add --help >/dev/null
    runHook postInstallCheck
  '';

  passthru = {
    app = midstudy-app;
    inherit (midstudy-app) wasm nodeModules;
  };

  meta = {
    description = "midstudy-add: a furniture photo or model to a normalized midstudy library item";
    mainProgram = "midstudy-add";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
