# midstudy-add: the furniture pipeline (pipeline/, contract §3) as one executable, on nixpkgs' python3 (3.13; the
# pipeline allows >=3.12,<3.14). planner/serve.py runs it for library jobs (§2.8) with --library <library-dir>.
# Keeps pipeline/pyproject.toml next to the source, so midstudy-add finds its root the way it does in git; it never
# writes there (the server always passes --library), and FAL_KEY comes from the environment (services.midstudy.falKeyFile).
# Pure Python, so it builds on the Mac too (aarch64-darwin), where it was checked; homeserver runs the x86_64-linux one.
{
  lib,
  stdenvNoCC,
  python3,
  makeWrapper,
}:
let
  fal-client = python3.pkgs.callPackage ./fal-client.nix { };
  py = python3.withPackages (ps: [
    ps.numpy
    ps.pillow
    ps.pillow-heif
    ps.trimesh
    fal-client
  ]);
in
stdenvNoCC.mkDerivation {
  pname = "midstudy-add";
  version = "0.2.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../pipeline/src
      ../pipeline/pyproject.toml
    ];
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/midstudy $out/bin
    cp -r pipeline $out/share/midstudy/
    makeWrapper ${py}/bin/python3 $out/bin/midstudy-add \
      --add-flags "-c 'from midstudy_pipeline.cli import main; main()'" \
      --set PYTHONPATH $out/share/midstudy/pipeline/src
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    $out/bin/midstudy-add --help >/dev/null
  '';

  passthru = { inherit fal-client; };

  meta = {
    description = "midstudy-add: a furniture photo or model to a normalized midstudy library item";
    mainProgram = "midstudy-add";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
