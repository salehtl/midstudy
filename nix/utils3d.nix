# utils3d (github.com/EasternJournalist/utils3d), the geometry helpers MoGe-2 imports. Not in nixpkgs, so it's built
# here from the commit MoGe v2.0.0 pins (the same one calib/uv.lock locks). midstudy-calib only runs its NumPy and
# PyTorch code, and those load lazily: moderngl (OpenGL rasterizing) and matplotlib (colour maps) are never imported
# on that path, so they're dropped from its requirements instead of being pulled into the closure.
{
  lib,
  buildPythonPackage,
  fetchFromGitHub,
  setuptools,
  wheel,
  numpy,
  scipy,
}:
buildPythonPackage {
  pname = "utils3d";
  version = "1.3-unstable-2025-10-07";
  pyproject = true;

  src = fetchFromGitHub {
    owner = "EasternJournalist";
    repo = "utils3d";
    rev = "3fab839f0be9931dac7c8488eb0e1600c236e183";
    hash = "sha256-UD04y+CF5ldb/RjcbUY95V8kjqbP4XKa+BY4by0uAUE=";
  };

  build-system = [
    setuptools
    wheel
  ];

  dependencies = [
    numpy
    scipy
  ];

  pythonRemoveDeps = [
    "moderngl"
    "matplotlib"
  ];

  pythonImportsCheck = [ "utils3d" ];

  meta = {
    description = "Geometry utilities for 3D computer vision (NumPy and PyTorch)";
    homepage = "https://github.com/EasternJournalist/utils3d";
    license = lib.licenses.mit;
  };
}
