import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_DIR = "chrome-live-screenshot-mcp";
const CAPTURES_DIR = "captures";

const HOURS_TO_MS = 60 * 60 * 1000;

export type ScreenshotArtifact = {
  artifactPath: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
};

export type CleanupArtifactsResult = {
  artifactDir: string;
  deletedCount: number;
  deletedBytes: number;
  keptCount: number;
  errorCount: number;
  maxAgeHours: number;
};

function resolveCacheRoot(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) {
      return appData;
    }
    return path.join(os.homedir(), "AppData", "Roaming");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }

  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache && xdgCache.length > 0) {
    return xdgCache;
  }
  return path.join(os.homedir(), ".cache");
}

function getArtifactExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "bin";
}

function nowFileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getImageDimensions(
  bytes: Buffer,
  mimeType: string
): { width: number; height: number } | null {
  if (mimeType === "image/png") {
    if (bytes.length < 24) return null;
    const pngSignature = "89504e470d0a1a0a";
    if (bytes.subarray(0, 8).toString("hex") !== pngSignature) return null;
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (mimeType === "image/jpeg") {
    if (bytes.length < 4) return null;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }

      if (offset + 3 >= bytes.length) break;
      const blockSize = bytes.readUInt16BE(offset + 2);
      if (blockSize < 2) break;
      if (offset + 2 + blockSize > bytes.length) break;

      const isSofMarker =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isSofMarker && blockSize >= 7) {
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        return { width, height };
      }

      offset += 2 + blockSize;
    }
  }

  return null;
}

function normalizeArtifactDir(artifactDir?: string): string {
  if (typeof artifactDir === "string" && artifactDir.trim().length > 0) {
    return artifactDir.trim();
  }

  return path.join(resolveCacheRoot(), APP_DIR, CAPTURES_DIR);
}

export function getDefaultArtifactDir(): string {
  return normalizeArtifactDir();
}

export async function writeScreenshotArtifact(args: {
  base64Data: string;
  mimeType: string;
  artifactDir?: string;
}): Promise<ScreenshotArtifact> {
  const artifactDir = normalizeArtifactDir(args.artifactDir);
  await fs.mkdir(artifactDir, { recursive: true });

  const ext = getArtifactExtension(args.mimeType);
  const name = `shot-${nowFileStamp()}-${crypto
    .randomBytes(4)
    .toString("hex")}.${ext}`;
  const artifactPath = path.join(artifactDir, name);

  const bytes = Buffer.from(args.base64Data, "base64");
  await fs.writeFile(artifactPath, bytes);

  const dimensions = getImageDimensions(bytes, args.mimeType);
  return {
    artifactPath,
    mimeType: args.mimeType,
    byteSize: bytes.byteLength,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

export async function cleanupScreenshotArtifacts(args: {
  artifactDir?: string;
  maxAgeHours: number;
}): Promise<CleanupArtifactsResult> {
  const artifactDir = normalizeArtifactDir(args.artifactDir);
  const cutoffMs = Date.now() - args.maxAgeHours * HOURS_TO_MS;

  const result: CleanupArtifactsResult = {
    artifactDir,
    deletedCount: 0,
    deletedBytes: 0,
    keptCount: 0,
    errorCount: 0,
    maxAgeHours: args.maxAgeHours,
  };

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(artifactDir, { withFileTypes: true });
  } catch (err) {
    const maybeCode = (err as { code?: string })?.code;
    if (maybeCode === "ENOENT") {
      return result;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(artifactDir, entry.name);

    try {
      const st = await fs.stat(filePath);
      if (st.mtimeMs <= cutoffMs) {
        await fs.unlink(filePath);
        result.deletedCount += 1;
        result.deletedBytes += st.size;
      } else {
        result.keptCount += 1;
      }
    } catch {
      result.errorCount += 1;
    }
  }

  return result;
}
