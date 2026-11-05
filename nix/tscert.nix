# TScert (https://github.com/cristianoc/TScert, NON-AI MIT licence: used here as a checker only), pinned, for
# `npm run check:tscert` (tscert/README.md).
#
# TScert pins Node 26.13.0 (.nvmrc, `engines`) and Lean 4.33.1 (lean/lean-toolchain). The pinned nixpkgs has Node
# 26.12.1 and Lean 4.29.1, so both come from their official release archives as fixed-output fetches: no nvm, no elan,
# nothing installed into ~. OCaml and dune come from nixpkgs (the producer needs OCaml 5 and only its standard library).
#
# `source` is the pinned commit; `built` is TScert built in the Nix sandbox (flake output `.#tscert`, a long Lean build
# the first time, so the dev shell does not depend on it); `command` is the `tscert` wrapper of the dev shell: it puts
# this Node and this Lean on PATH and runs scripts/tscert.mjs, whose `tscert build` builds `.#tscert` on first use
# (out-link build/tscert/result, a GC root in the git-ignored build/).
{ pkgs }:
let
  inherit (pkgs) lib stdenv;
  system = stdenv.hostPlatform.system;

  rev = "1c8abcf21dbbc9cbb87d5a5f74820a08d2459899"; # main, 2026-11-05 18:14 +0100
  source = pkgs.fetchFromGitHub {
    owner = "cristianoc";
    repo = "TScert";
    inherit rev;
    hash = "sha256-xMP4OhFWkq2kXaVH4KZKuC28XQ9CjuF2sj/z/Leapvg=";
  };

  nodeDist =
    {
      aarch64-darwin = {
        url = "https://nodejs.org/dist/v26.13.0/node-v26.13.0-darwin-arm64.tar.xz";
        hash = "sha256-b1sxh9nfn8AH6IEWeQW8fWmtJkUN3Dd8g9YyVqJJW24=";
      };
      x86_64-linux = {
        url = "https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz";
        hash = "sha256-0oqWr2w4WW9tnZfA7lMcE9I411d0I4fRko3oItlZ6Zc=";
      };
    }
    .${system};
  leanDist =
    {
      aarch64-darwin = {
        url = "https://github.com/leanprover/lean4/releases/download/v4.33.1/lean-4.33.1-darwin_aarch64.tar.zst";
        hash = "sha256-iMRarZhbXSqNkl/hC9Epa9NfZvQISAqxgtP6zM0GWp0=";
      };
      x86_64-linux = {
        url = "https://github.com/leanprover/lean4/releases/download/v4.33.1/lean-4.33.1-linux.tar.zst";
        hash = "sha256-iQr9GFNw+FZmAluIORSrT0szkTb4yWFntpz7Yq7K8jU=";
      };
    }
    .${system};

  # The release archives as they are: on macOS nothing is patched (patching would break the code signatures); on
  # Linux the interpreters and RPATHs are patched (untested here: the Mac is the only machine that runs TScert).
  prebuilt =
    {
      pname,
      version,
      dist,
      extraNative ? [ ],
    }:
    stdenv.mkDerivation {
      inherit pname version;
      src = pkgs.fetchurl dist;
      nativeBuildInputs = extraNative ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
      buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
        stdenv.cc.cc.lib
        pkgs.zlib
      ];
      dontConfigure = true;
      dontBuild = true;
      dontStrip = true;
      dontPatchShebangs = true;
      installPhase = ''
        runHook preInstall
        mkdir -p $out
        cp -R . $out/
        runHook postInstall
      '';
    };

  node = prebuilt {
    pname = "tscert-node";
    version = "26.13.0";
    dist = nodeDist;
  };
  lean = prebuilt {
    pname = "tscert-lean";
    version = "4.33.1";
    dist = leanDist;
    extraNative = [ pkgs.zstd ];
  };

  # tools/node_modules (TypeScript 7.0.2 with this platform's native compiler, katex, @types/node) as a fixed-output
  # derivation: `npm ci --ignore-scripts` from tools/package-lock.json (some of its entries carry no `resolved` or
  # `integrity`, so nixpkgs' importNpmLock cannot read it). No package script runs; the output hash pins the result.
  toolsModules = stdenv.mkDerivation {
    name = "tscert-tools-node-modules";
    src = "${source}/tools";
    nativeBuildInputs = [ node ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR npm_config_cache=$TMPDIR/npm-cache
      npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier
      rm -f node_modules/.package-lock.json
      runHook postBuild
    '';
    installPhase = ''
      mv node_modules $out
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash =
      {
        aarch64-darwin = "sha256-HT7BguRSt0IXVNeKzo7aRtBI9OjAydjm1lUNOoSW8Rw=";
        x86_64-linux = lib.fakeHash; # not built yet: the first Linux build prints the hash to put here
      }
      .${system};
  };

  # TScert built in the Nix sandbox (the nixbld build user, no network): the front end in tools/ with the modules above,
  # the stage runner, the OCaml producer and the Lean verifier. Only the verifier binary is kept from lean/.lake.
  built = stdenv.mkDerivation {
    pname = "tscert-built";
    version = "0-unstable-2026-11-05";
    src = source;
    nativeBuildInputs = [
      node
      lean
      pkgs.ocaml
      pkgs.dune_3
    ];
    dontStrip = true;
    dontPatchShebangs = true;
    # One change to TScert, for the sandboxed runs only (runUnits sets TSCERT_NO_COMPILER_SANDBOX=1): inside a Nix build
    # on macOS, sandbox_apply refuses every profile with a deny rule ("Operation not permitted", measured 2026-11-05), so
    # TScert's confined compiler (sandbox-exec) dies at start. With the variable set, the compiler runs unconfined, which
    # TScert supports on any platform without a sandbox: it then records its stages as unobserved (no stage-store reuse);
    # what it verifies is unchanged. The Nix build user cannot read your files either way.
    postPatch = ''
      substituteInPlace tools/compiler-channel.mts --replace-fail \
        'const macOS = process.platform === "darwin" && installed("/usr/bin/sandbox-exec");' \
        'const macOS = process.platform === "darwin" && installed("/usr/bin/sandbox-exec") && process.env["TSCERT_NO_COMPILER_SANDBOX"] !== "1";'
    '';
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      cp -R ${toolsModules} tools/node_modules
      chmod -R u+w tools/node_modules
      mkdir -p pipeline/runner/_build
      # The stdenv compiler by its full path: the Lean release ships its own clang, first on PATH here.
      ${stdenv.cc}/bin/cc -O2 -Wall -Wextra -Werror -o pipeline/runner/_build/stage-runner pipeline/runner/stage-runner.c
      dune build --root ocaml-producer
      (cd lean && lake build --log-level=warning)
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lean/.lake/build
      for f in $(ls -A | grep -v '^lean$'); do cp -R "$f" $out/; done
      for f in $(ls -A lean | grep -v '^\.lake$'); do cp -R "lean/$f" $out/lean/; done
      cp -R lean/.lake/build/bin $out/lean/.lake/build/
      echo ${rev} > $out/.tscert-rev
      runHook postInstall
    '';
  };

  # TScert runs inside the Nix sandbox, never as the user: `runUnits` checks a copy of the inputs (`src`, made by
  # scripts/tscert-ratchet.mjs with builtins.path: the tsconfigs, scripts/tscert.mjs, the logic modules, contract/gen
  # and build/tscert/jobs.json) with `tscert units --batch` and writes its JSON result as the output. The same inputs
  # give the same derivation, so an unchanged tree is checked once and then read from the store.
  runUnits =
    { src }:
    pkgs.runCommand "tscert-units"
      {
        inherit src;
        nativeBuildInputs = [ node ];
        TSCERT_REV = rev;
        TSCERT_SOURCE = "${source}";
        TSCERT_LEAN = "${lean}";
        TSCERT_NODE = "${node}";
        TSCERT_NO_COMPILER_SANDBOX = "1";
      }
      ''
        cp -R $src work
        chmod -R u+w work
        cd work
        mkdir -p build/tscert
        ln -s ${built} build/tscert/result
        export HOME=$TMPDIR
        node scripts/tscert.mjs units --batch build/tscert/jobs.json > $out
      '';

  command = pkgs.writeShellApplication {
    name = "tscert";
    runtimeInputs = [
      node
      lean
      pkgs.ocaml
      pkgs.dune_3
      pkgs.git
      pkgs.gnumake
    ];
    runtimeEnv = {
      TSCERT_SOURCE = "${source}";
      TSCERT_REV = rev;
      TSCERT_LEAN = "${lean}";
      TSCERT_NODE = "${node}";
    };
    text = ''
      root=$(git rev-parse --show-toplevel 2>/dev/null) || {
        echo "tscert: run me inside the midstudy repository" >&2
        exit 2
      }
      exec node "$root/scripts/tscert.mjs" "$@"
    '';
  };
in
{
  inherit
    rev
    source
    node
    lean
    toolsModules
    built
    runUnits
    command
    ;
}
