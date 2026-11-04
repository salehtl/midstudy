# NixOS module for midstudy on a GPU host (homeserver): one service, the web app (planner/serve.py through the midstudy
# package's midstudy-web), which runs midstudy-calib (MoGe-2 on the GPU) for each uploaded photo and midstudy-add for
# each library item. It listens on 127.0.0.1 only; the host's proxy decides who can reach it and under which name
# (allowedHosts). Paid fal calls (library adds from photos, Render) need falKeyFile and stay under dailySpendUsd.
# Modelled on nook's nix/module.nix (same user/group pattern, tmpfiles and hardening).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.midstudy;
  dir = cfg.dataDir;
  calib = lib.getExe cfg.package.passthru.midstudy-calib;
  # `run` and `fit` take --device; `ingest` and `align` don't (contract §4.3). serve.py appends the subcommand and its
  # arguments to --calib, so the device goes last. "auto" needs no shim: the CLI's own default is auto.
  calibCmd =
    if cfg.calibDevice == "auto" then
      calib
    else
      toString (
        pkgs.writeShellScript "midstudy-calib-${cfg.calibDevice}" ''
          case "$1" in
            run | fit) exec ${calib} "$@" --device ${cfg.calibDevice} ;;
            *) exec ${calib} "$@" ;;
          esac
        ''
      );
in
{
  options.services.midstudy = {
    enable = lib.mkEnableOption "midstudy: place real-size 3D furniture on a phone photo of a room";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.midstudy;
      defaultText = lib.literalExpression "midstudy.packages.\${system}.midstudy";
      description = "The midstudy package (midstudy-web, with midstudy-calib and midstudy-add in its passthru).";
    };

    webPort = lib.mkOption {
      type = lib.types.port;
      default = 8780;
      description = ''
        Web app port on 127.0.0.1. 8780 stays clear of nook's (its module defaults are 8096 for the web app and 8095
        for nook-scan; serve.py's own default is 8765).
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/midstudy";
      description = "Scenes (uploaded photos, calibrations), library, layouts and renders; also the service's HOME.";
    };

    falKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/midstudy-fal";
      description = ''
        An EnvironmentFile holding `FAL_KEY=...` for the paid fal calls (library adds from photos, Render). A path
        string, so the secret never lands in the Nix store; systemd reads it as root, so it can be root-only. Null:
        those calls answer "FAL_KEY not set" (placing GLB/OBJ items and calibrating photos still work).
      '';
    };

    dailySpendUsd = lib.mkOption {
      type = lib.types.numbers.nonnegative;
      default = 2;
      description = "Cap on paid fal calls per UTC day, in USD (`midstudy-web --daily-spend-usd`, contract §2.9). 0 blocks them all.";
    };

    allowedHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "midstudy.salehtl.com" ];
      description = ''
        Host names the web app answers besides loopback ones (`midstudy-web --allowed-host`, contract §2.9): the
        names the host's proxy serves it under. Any other Host gets a 403, against DNS rebinding.
      '';
    };

    calibDevice = lib.mkOption {
      type = lib.types.enum [
        "auto"
        "cuda"
        "cpu"
      ];
      default = "auto";
      description = ''
        Device for MoGe-2 (`midstudy-calib --device`). auto: CUDA when torch can see the GPU, else the CPU; under
        auto a failed CUDA inference (e.g. out of memory while nook-scan trains) is retried on the CPU. cuda: an
        unavailable GPU still falls back to the CPU (logged), but a failed CUDA inference is not retried, so the
        scene gets the EXIF/default camera. cpu: never touch the GPU (slower, tens of seconds per photo).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.midstudy = {
      isSystemUser = true;
      group = "midstudy";
      # The NVIDIA device nodes, for MoGe-2 on CUDA.
      extraGroups = [
        "video"
        "render"
      ];
      home = dir;
    };
    users.groups.midstudy = { };

    systemd.tmpfiles.settings."10-midstudy" =
      lib.genAttrs
        [
          dir
          "${dir}/scenes"
          "${dir}/library"
          "${dir}/layouts"
          "${dir}/renders"
        ]
        (_: {
          d = {
            user = "midstudy";
            group = "midstudy";
            mode = "0750";
          };
        });

    systemd.services.midstudy = {
      description = "midstudy web app (planner, scene calibration with MoGe-2, furniture library, renders)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        HOME = dir;
        # There is no .env in the store; this makes sure the key can only come from falKeyFile.
        MIDSTUDY_NO_DOTENV = "1";
      };
      serviceConfig =
        {
          User = "midstudy";
          Group = "midstudy";
          WorkingDirectory = dir;
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          ReadWritePaths = [ dir ];
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictSUIDSGID = true;
          LockPersonality = true;
          Restart = "on-failure";
          RestartSec = 5;
        }
        // lib.optionalAttrs (cfg.falKeyFile != null) { EnvironmentFile = cfg.falKeyFile; }
        // {
          ExecStart = lib.escapeShellArgs (
            [
              (lib.getExe cfg.package)
              "--host"
              "127.0.0.1"
              "--port"
              (toString cfg.webPort)
              "--scenes-dir"
              "${dir}/scenes"
              "--library-dir"
              "${dir}/library"
              "--layouts-dir"
              "${dir}/layouts"
              "--renders-dir"
              "${dir}/renders"
              "--calib"
              calibCmd
              "--daily-spend-usd"
              (toString cfg.dailySpendUsd)
            ]
            ++ lib.concatMap (h: [
              "--allowed-host"
              h
            ]) cfg.allowedHosts
          );
        };
    };
  };
}
