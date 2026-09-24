import { open } from "node:fs/promises";
import type { ArchivePreview } from "../archivePreview";

type ZipPreviewEntry = ArchivePreview["entries"][number];

// ZIP stores its directory at the end, so listing never decompresses file data.
export async function readZipDirectory(filePath: string): Promise<ZipPreviewEntry[]> {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    const read = async (offset: number, length: number) => {
      if (offset < 0 || offset + length > size) throw new Error("Invalid ZIP directory bounds.");
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await file.read(buffer, total, length - total, offset + total);
        if (!bytesRead) throw new Error("Incomplete ZIP directory.");
        total += bytesRead;
      }
      return buffer;
    };
    const tail = await read(Math.max(0, size - 65_557), Math.min(size, 65_557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("ZIP directory could not be found.");
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
      throw new Error("ZIP64 directory previews are not supported yet.");
    }
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count) {
      throw new Error("Multi-part ZIP previews are not supported.");
    }
    if (count > 10_000 || length > 8 * 1024 * 1024) throw new Error("ZIP directory is too large to preview.");
    if (offset + length > size - tail.length + end) throw new Error("Invalid ZIP directory bounds.");
    const directory = await read(offset, length);
    const entries: ZipPreviewEntry[] = [];
    let pathParts = 0;
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP directory entry.");
      const nameLength = directory.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
      if (next > length) throw new Error("Incomplete ZIP directory entry.");
      const path = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      const depth = path.split(/[\\/]/).length;
      pathParts += depth;
      if (depth > 64 || pathParts > 20_000) throw new Error("ZIP directory is too complex to preview.");
      const size = directory.readUInt32LE(cursor + 24);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      if (size === 0xffffffff || compressedSize === 0xffffffff) throw new Error("ZIP64 directory previews are not supported yet.");
      entries.push({ path, directory: path.endsWith("/"), size, compressedSize });
      cursor = next;
    }
    return entries;
  } finally {
    await file.close();
  }
}
