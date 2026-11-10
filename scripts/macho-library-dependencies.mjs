// Parser for `/usr/bin/otool -L` output used by the packaged-runtime verifier.
//
// A thin Mach-O prints one header line ("<path>:") followed by tab-indented
// LC_*_DYLIB entries. A universal (fat) binary prints one header per slice:
//   <path> (architecture x86_64):
//       /usr/lib/...
//   <path> (architecture arm64):
//       /usr/lib/...
// Those extra headers are NOT dependencies. Splitting one on " (" yields the
// binary's own absolute path, which the verifier used to report as an
// "External library dependency" as soon as a fat helper (Sparkle's Autoupdate)
// was embedded in the app bundle.
export function libraryDependencies(otoolOutput) {
  const dependencies = [];
  for (const line of otoolOutput.split('\n')) {
    if (!line.startsWith('\t')) continue;
    const dependency = line.trim().split(' (')[0];
    if (dependency) dependencies.push(dependency);
  }
  return dependencies;
}

// Dependencies must resolve inside the bundle (@rpath / @loader_path /
// @executable_path) or come from the OS itself. Nothing else is allowed: an
// absolute path into a build/staging tree would break after installation.
export function isBundledRuntimeDependency(dependency) {
  return dependency.startsWith('/usr/lib/')
    || dependency.startsWith('/System/Library/')
    || dependency.startsWith('@');
}
