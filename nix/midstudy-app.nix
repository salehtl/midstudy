# midstudy's built tree: what `npm ci && npm run build` makes in a checkout, with only the files that run.
#
#   share/midstudy/
#     package.json                      "type": "module" for the .ts files Node runs with its type stripping
#     server/src/  common/  core/js/    the server (node server/src/main.ts) and what it imports
#     pipeline/src/                     midstudy-add (node pipeline/src/cli.ts)
#     contract/gen/                     the generated validators (strict mode, MIDSTUDY_STRICT=1)
#     planner/                          index.html, styles, icons and dist/ (the bundle: no dist/, no script on the page)
#     build/wasm/{node,pipeline,product}/   the Node kernels (nix/wasm.nix); the web one is in planner/dist/
#     node_modules -> the runtime npm packages (nix/node-modules.nix)
#
# The layout is the repository's because every module finds the others relative to itself (core/js/node.ts loads
# ../../build/wasm/node/, the server serves ../../planner/). The planner bundle is scripts/build.mjs --planner-only, so
# esbuild runs with the script's options against the wasm built by nix/wasm.nix. nix/midstudy.nix (midstudy-web) and
# nix/midstudy-add.nix (midstudy-add) are wrappers around this tree.
{
  lib,
  stdenvNoCC,
  callPackage,
  nodejs_22,
  rust,
}:
let
  wasm = callPackage ./wasm.nix { inherit rust; };
  nodeModules = callPackage ./node-modules.nix { };
  # Files the build reads and the tree ships: tests and the Rust sources stay out.
  sources = [
    ../package.json
    ../tsconfig.json
    ../scripts/build.mjs
    ../scripts/lib
    ../planner
    ../core/js
    ../server/src
    ../common
    ../pipeline/src
    ../contract/gen
  ];
in
stdenvNoCC.mkDerivation {
  pname = "midstudy-app";
  version = "2.0.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions sources;
  };

  nativeBuildInputs = [ nodejs_22 ];

  # esbuild resolves three and Spark through node_modules. A copy, not a link to the store: esbuild follows links to their
  # real path, which would name /nix/store in the source maps and change the chunks' hashed names; from a copy the
  # bundle is byte for byte the one `npm run build` makes in a checkout (only the web .wasm differs: rustc records its
  # source paths). The kernels go where the bundle and the decoders' copy expect them (build/wasm/web/, then
  # planner/dist/).
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -r ${nodeModules.build}/node_modules node_modules
    chmod -R u+w node_modules
    mkdir -p build
    cp -r ${wasm}/wasm build/wasm
    chmod -R u+w build
    node scripts/build.mjs --planner-only
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    d=$out/share/midstudy
    mkdir -p $d/core $d/build/wasm
    cp package.json $d/
    cp -r --parents server/src common pipeline/src contract/gen $d/
    cp -r core/js $d/core/
    # The planner as served: everything but its TypeScript and test scripts (bundled into dist/).
    find planner -type f ! -name '*.ts' ! -name '*.mjs' -exec cp --parents {} $d/ \;
    for k in node pipeline product; do cp -r build/wasm/$k $d/build/wasm/; done
    ln -s ${nodeModules.runtime}/node_modules $d/node_modules
    runHook postInstall
  '';

  # The page's script and the wasm it loads are there, and the Node kernels load (each face reads its .wasm on first
  # use, so call one function of each).
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    d=$out/share/midstudy
    test -s $d/planner/dist/app.js
    test -s $d/planner/dist/midstudy_wasm_web_bg.wasm
    grep -q 'src="./dist/app.js"' $d/planner/index.html
    cd $d
    node --input-type=module -e "
      const media = await import('./core/js/node.ts')
      if (media.isSlug('a-b') !== true) throw new Error('core/js/node.ts: isSlug')
      const kernels = await import('./core/js/pipeline.ts')
      if (kernels.imageProbe(new Uint8Array([1, 2, 3])).ok !== false) throw new Error('core/js/pipeline.ts: imageProbe')
      const sizes = await import('./server/src/product/sizes.ts')
      if (typeof sizes.hasSize('60 x 40 cm') !== 'boolean') throw new Error('server/src/product/sizes.ts: hasSize')
      await import('@gltf-transform/core')
    "
    cd - >/dev/null
    runHook postInstallCheck
  '';

  passthru = {
    inherit wasm nodeModules;
    nodejs = nodejs_22;
  };

  meta = {
    description = "midstudy's built web app and CLI sources (planner bundle, server, midstudy-add, wasm kernels)";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
}
