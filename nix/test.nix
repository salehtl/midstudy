# A NixOS VM test of services.midstudy (x86_64-linux; needs KVM, no GPU): the service starts under its hardening,
# serves the planner, enforces the Host rule, takes a photo upload and calibrates it, and adds a GLB to the library
# through midstudy-add. Calibration uses MIDSTUDY_CALIB_MOCK, so ingest runs for real through the packaged
# midstudy-calib and fit copies the golden scene's calibration without loading MoGe. fal is mocked and the cap is $0.
# calibDevice = "cpu" exercises the module's device shim.
#   nix build .#checks.x86_64-linux.service -L
{
  self,
  pkgs,
}:
let
  inherit (pkgs) lib;
  fixtures = lib.fileset.toSource {
    root = ../fixtures;
    fileset = lib.fileset.unions [
      ../fixtures/fal
      ../fixtures/calib
      ../fixtures/scenes/living-wide/photo.jpg
      ../fixtures/models/SheenChair.glb
    ];
  };
in
pkgs.testers.runNixOSTest {
  name = "midstudy-service";

  nodes.machine = {
    imports = [ self.nixosModules.default ];
    services.midstudy = {
      enable = true;
      dailySpendUsd = 0;
      allowedHosts = [ "midstudy.test" ];
      calibDevice = "cpu";
    };
    systemd.services.midstudy.environment = {
      MIDSTUDY_FAL_MOCK = "${fixtures}/fal";
      MIDSTUDY_CALIB_MOCK = "${fixtures}/calib";
    };
    environment.systemPackages = [
      pkgs.curl
      pkgs.jq
    ];
    virtualisation.memorySize = 2048;
  };

  testScript = ''
    import base64, json

    base = "http://127.0.0.1:8780"
    machine.wait_for_unit("midstudy.service")
    machine.wait_for_open_port(8780)

    with subtest("planner and Host rule"):
        machine.succeed(f"curl -sf {base}/planner/ | grep -q '<title>midstudy planner</title>'")
        machine.succeed(f"test $(curl -s -o /dev/null -w '%{{http_code}}' -H 'Host: evil.example' {base}/planner/) = 403")
        machine.succeed(f"test $(curl -s -o /dev/null -w '%{{http_code}}' -H 'Host: midstudy.test' {base}/planner/) = 200")

    with subtest("upload a photo, it calibrates"):
        up = json.loads(machine.succeed(
            f"curl -sf -X POST -H 'X-Midstudy: 1' -H 'X-Midstudy-Filename: photo.jpg' "
            f"-H 'Content-Type: application/octet-stream' --data-binary @${fixtures}/scenes/living-wide/photo.jpg {base}/api/scenes"
        ))
        name = up["scene"]
        machine.wait_until_succeeds(f"curl -sf {base}/api/scenes/{name} | jq -e '.calib_status == \"done\"'", timeout=180)
        scene = json.loads(machine.succeed(f"curl -sf {base}/api/scenes/{name}"))
        assert scene["calib"]["source"] == "truth", scene["calib"]
        assert abs(scene["camera"]["fov_y_deg"] - 55) < 0.01, scene["camera"]
        machine.succeed(f"curl -sf -o /dev/null {base}/scenes/{name}/photo.jpg")
        machine.succeed(f"curl -sf -o /dev/null {base}/scenes/{name}/depth.png")
        machine.fail(f"curl -sf -o /dev/null {base}/scenes/{name}/source.jpg")
        machine.succeed(f"test -f /var/lib/midstudy/scenes/{name}/calib.json")

    with subtest("a GLB through the library (midstudy-add)"):
        meta = base64.b64encode(json.dumps({"name": "Sheen Chair", "dims_cm": {"w": 60, "d": 65, "h": 85}}).encode()).decode()
        add = json.loads(machine.succeed(
            f"curl -sf -X POST -H 'X-Midstudy: 1' -H 'X-Midstudy-Kind: model' -H 'X-Midstudy-Filename: SheenChair.glb' "
            f"-H 'X-Midstudy-Meta: {meta}' -H 'Content-Type: application/octet-stream' "
            f"--data-binary @${fixtures}/models/SheenChair.glb {base}/api/library/items"
        ))
        job = add["job"]["id"]
        machine.wait_until_succeeds(f"curl -sf {base}/api/library/jobs/{job} | jq -e '.status == \"done\"'", timeout=180)
        machine.succeed(f"curl -sf {base}/library/library.json | jq -e '.items | length == 1'")
        machine.succeed("test $(stat -c %U /var/lib/midstudy/library/library.json) = midstudy")
  '';
}
