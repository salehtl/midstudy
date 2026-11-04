{
  # midstudy: see furniture in a photo of your room before you buy it (PLAN.md).
  # Dev shells for both machines; packages and nixosModules.default for hosting on homeserver (PLAN.md §9,
  # docs/HANDOFF.md). The packages target x86_64-linux (CUDA); aarch64-darwin builds them too, with MPS, so the
  # packaging can be checked on the Mac.
  description = "midstudy: place real-size 3D furniture on a phone photo of a room";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Tools come from here: `nix develop -c <cmd>` from the repo root (CLAUDE.md).
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.python312
            pkgs.uv
            pkgs.nodejs_22
            pkgs.git
          ];
          # uv uses the shell's Python 3.12 instead of downloading one.
          UV_PYTHON = "${pkgs.python312}/bin/python3.12";
          UV_PYTHON_DOWNLOADS = "never";
        };
      });

      packages = forAll (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) system;
        in
        rec {
          # The furniture pipeline (contract §3) on nixpkgs' python3, with fal-client packaged in nix/fal-client.nix.
          midstudy-add = pkgs.callPackage ./nix/midstudy-add.nix { };
          fal-client = midstudy-add.fal-client;
          # Photo ingest, MoGe-2 calibration and keep-room alignment (contract §4.3) on torch-bin: CUDA on Linux,
          # MPS on macOS. torch-bin is unfree, so nix/midstudy-calib.nix allows it in its own nixpkgs instance
          # (configured as nook's, so homeserver reuses nook's torch-bin); nothing else changes.
          midstudy-calib = import ./nix/midstudy-calib.nix { inherit nixpkgs system; };
          # The MoGe-2 ViT-L weights (1.32 GB, fixed-output) as a read-only Hugging Face cache; midstudy-calib's default.
          moge-weights = midstudy-calib.weights;
          # The web app: planner/ and planner/serve.py, wired to the two above (bin/midstudy-web).
          midstudy = pkgs.callPackage ./nix/midstudy.nix { inherit midstudy-add midstudy-calib; };
          default = midstudy;
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
