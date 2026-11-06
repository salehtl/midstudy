{
  # midstudy: see furniture in a photo of your room before you buy it (PLAN.md).
  # Dev shells for both machines; packages and nixosModules.default for hosting on homeserver (PLAN.md §9,
  # docs/HANDOFF.md). The packages target x86_64-linux (CUDA); aarch64-darwin builds them too, with MPS, so the
  # packaging can be checked on the Mac.
  description = "midstudy: place real-size 3D furniture on a phone photo of a room";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    # Rust toolchains as the official binaries (docs/REFACTOR.md §1): stable 1.95.0 with wasm32, and a dated nightly
    # for Miri, cargo-fuzz and Kani (nix/toolchain.nix).
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      toolchain =
        pkgs:
        let
          # The proofs track may pin the Lean that Mathlib needs in nix/lean.nix (a fixed-output fetch, not elan).
          lean = if builtins.pathExists ./nix/lean.nix then import ./nix/lean.nix { inherit pkgs; } else pkgs.lean4;
        in
        import ./nix/toolchain.nix { inherit pkgs rust-overlay lean; };
    in
    {
      # Tools come from here: `nix develop -c <cmd>` from the repo root (CLAUDE.md). `default` has everything the
      # build and the checks need (python 3.12, uv, node 22, git, Rust 1.95.0 + wasm32, wasm-bindgen, wasm-opt, Lean,
      # pyright, ruff, tscert); `nightly` is the dated nightly with Miri for `check:rust` and `check:fuzz`.
      devShells = forAll (
        pkgs:
        let
          tc = toolchain pkgs;
        in
        {
          inherit (tc) default nightly;
        }
      );

      packages = forAll (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) system;
          # The built tree (`npm ci && npm run build` in Nix): the planner bundle, the server, midstudy-add's sources,
          # the wasm kernels (nix/wasm.nix, Rust 1.95.0 from rust-overlay) and the npm packages (nix/node-modules.nix).
          midstudy-app = pkgs.callPackage ./nix/midstudy-app.nix { rust = (toolchain pkgs).rustWasm; };
        in
        rec {
          # The furniture CLI (contract §3): Node 22 + wasm (bin/midstudy-add). Its parts: .app, .wasm, .nodeModules.
          midstudy-add = pkgs.callPackage ./nix/midstudy-add.nix { inherit midstudy-app; };
          # Photo ingest, MoGe-2 calibration, lighting and keep-room alignment (contract §4.3), with the warm worker
          # (`midstudy-calib serve`), on torch-bin: CUDA on Linux, MPS on macOS. torch-bin is unfree, so
          # nix/midstudy-calib.nix allows it in its own nixpkgs instance (configured as nook's, so homeserver reuses nook's
          # torch-bin); nothing else changes.
          midstudy-calib = import ./nix/midstudy-calib.nix { inherit nixpkgs system; };
          # The MoGe-2 ViT-L weights (1.32 GB, fixed-output) as a read-only Hugging Face cache; midstudy-calib's default.
          moge-weights = midstudy-calib.weights;
          # The web app: the server (Node 22) and the planner bundle, wired to the two above (bin/midstudy-web).
          midstudy = pkgs.callPackage ./nix/midstudy.nix { inherit midstudy-app midstudy-add midstudy-calib; };
          default = midstudy;
          # TScert built at the commit nix/tscert.nix pins: `tscert build` (the dev shell's command) builds it on first use.
          tscert = (import ./nix/tscert.nix { inherit pkgs; }).built;
        }
      );

      # services.midstudy (nix/module.nix): webPort, dataDir, falKeyFile, dailySpendUsd, allowedHosts, calibDevice.
      nixosModules.default = import ./nix/module.nix self;

      # A NixOS VM test of the module (KVM, no GPU, fal and MoGe mocked): `nix build .#checks.x86_64-linux.service -L`.
      checks.x86_64-linux.service = import ./nix/test.nix {
        inherit self;
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
      };
    };
}
