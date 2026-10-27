export interface DownloadCatalog {
  macOS: { version: string | null; dmgURL: string | null; pkgURL: string | null };
  iOSURL: string | null;
  notesURL: string | null;
}

export function parseDownloadURL(value: string | undefined, platform: "macOS" | "iOS" | "notes"): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  const allowed = platform === "iOS" ? ["apps.apple.com", "testflight.apple.com"] : ["github.com"];
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || !allowed.includes(url.hostname)) throw new Error(`Invalid ${platform} download URL`);
  if (platform !== "iOS" && !/^\/soapjk\/corptie\/releases(?:\/|$)/.test(url.pathname)) {
    throw new Error("Download URL must target a Corptie release");
  }
  if (platform === "macOS" && !/^\/soapjk\/corptie\/releases\/download\/[^/]+\/[^/]+\.(dmg|pkg)$/.test(url.pathname)) {
    throw new Error("macOS download URL must target a versioned DMG or PKG asset");
  }
  return url.href;
}

export function loadDownloadCatalog(environment: NodeJS.ProcessEnv): DownloadCatalog {
  const version = environment.CORPTIE_CLOUD_DOWNLOAD_MACOS_VERSION?.trim() || null;
  if (version && (version.length > 80 || /[\x00-\x1f\x7f]/.test(version))) throw new Error("Invalid macOS download version");
  const dmgURL = parseDownloadURL(environment.CORPTIE_CLOUD_DOWNLOAD_MACOS_DMG_URL, "macOS");
  const pkgURL = parseDownloadURL(environment.CORPTIE_CLOUD_DOWNLOAD_MACOS_PKG_URL, "macOS");
  if ((dmgURL || pkgURL) && !version) throw new Error("A published macOS download requires its version");
  if (dmgURL && !new URL(dmgURL).pathname.endsWith(".dmg")) throw new Error("DMG URL must end in .dmg");
  if (pkgURL && !new URL(pkgURL).pathname.endsWith(".pkg")) throw new Error("PKG URL must end in .pkg");
  return {
    macOS: { version, dmgURL, pkgURL },
    iOSURL: parseDownloadURL(environment.CORPTIE_CLOUD_DOWNLOAD_IOS_URL, "iOS"),
    notesURL: parseDownloadURL(environment.CORPTIE_CLOUD_DOWNLOAD_NOTES_URL, "notes")
  };
}
