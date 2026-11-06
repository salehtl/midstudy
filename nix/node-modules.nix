# midstudy's npm packages from package.json and package-lock.json, through importNpmLock: every package is fetched by
# the integrity hash the lockfile records, so there is no npm hash to keep up to date (package-lock.json is
# shared-append and changes often). Two sets, each what `npm ci` installs:
#
#   build     every package (`npm ci`): esbuild, three.js and Spark for the planner bundle (nix/midstudy-app.nix)
#   runtime   the "dependencies" only (`npm ci --omit=dev`): glTF-Transform, fflate, libheif-js, obj2gltf (and the
#             cesium it brings), parse5; what the server and midstudy-add load at run time
#
# Packages built for another platform (esbuild's and oxc's per-platform binaries, all optional) are kept in the lock but
# lose their `resolved` URL: importNpmLock then fetches nothing for them, and npm skips them by their os/cpu as it
# always does, so a build downloads only this platform's binaries.
{
  lib,
  stdenv,
  importNpmLock,
  nodejs_22,
}:
let
  package = lib.importJSON ../package.json;
  packageLock = lib.importJSON ../package-lock.json;

  # npm's names for this platform (process.platform, process.arch).
  npmOs = if stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  npmCpu =
    {
      aarch64 = "arm64";
      x86_64 = "x64";
    }
    .${stdenv.hostPlatform.parsed.cpu.name};
  # An os/cpu list that names other platforms only (npm also allows "!name" exclusions; none are in the lock today,
  # and a list with one is kept, so npm decides).
  excludes = want: list: !(lib.elem want list) && !(lib.any (lib.hasPrefix "!") list);
  foreign = m: (m ? os && excludes npmOs m.os) || (m ? cpu && excludes npmCpu m.cpu);
  local = lib.mapAttrs (
    _: m: if m.optional or false && foreign m then removeAttrs m [ "resolved" ] else m
  );

  nodeModules =
    name: package: packages:
    importNpmLock.buildNodeModules {
      inherit package;
      packageLock = packageLock // {
        packages = local packages;
      };
      nodejs = nodejs_22;
      derivationArgs = {
        pname = "midstudy-node-modules-${name}";
        version = "2.0.0";
        # npm's own record of the install names every package's tarball in the store, which would keep all of them
        # alive beside the unpacked packages; Node never reads it.
        postInstall = ''
          rm -f $out/node_modules/.package-lock.json
        '';
      };
    };
in
{
  build = nodeModules "build" package packageLock.packages;

  # Without the devDependencies on both sides, package.json and the lock agree, so npm installs exactly the packages the
  # lock does not mark "dev" (what `npm ci --omit=dev` installs from the full lock).
  runtime = nodeModules "runtime" (removeAttrs package [ "devDependencies" ]) (
    lib.filterAttrs (_: m: !(m.dev or false)) packageLock.packages
    // {
      "" = removeAttrs packageLock.packages."" [ "devDependencies" ];
    }
  );
}
