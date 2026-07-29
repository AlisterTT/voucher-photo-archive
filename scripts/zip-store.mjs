import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { beijingParts } from "./beijing-time.mjs";

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function updateCrc(crc, chunk) {
  let value = crc;
  for (const byte of chunk) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function dosDateTime(date) {
  const value = beijingParts(date);
  const year = Math.max(1980, value.year);
  return {
    date: ((year - 1980) << 9) | (value.month << 5) | value.day,
    time: (value.hour << 11) | (value.minute << 5) | Math.floor(value.second / 2),
  };
}

function localHeader(name, modified) {
  const header = Buffer.alloc(30);
  const { date, time } = dosDateTime(modified);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function dataDescriptor(crc, size) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc >>> 0, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  const { date, time } = dosDateTime(entry.modified);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function endRecord(entries, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(entries, 8);
  record.writeUInt16LE(entries, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  return record;
}

async function write(stream, buffer) {
  if (!stream.write(buffer)) await once(stream, "drain");
}

export async function createStoredZip({ files, rootDir, output, onProgress }) {
  const entries = [];
  const outputStream = fs.createWriteStream(output, { flags: "wx" });
  let offset = 0;
  let processedBytes = 0;
  try {
    for (const file of files) {
      const stat = await fsp.stat(file);
      if (stat.size > 0xffffffff) throw new Error("单个文件超过 4GB，当前 ZIP 格式不支持。");
      const relative = path.relative(rootDir, file).split(path.sep).join("/");
      const name = Buffer.from(relative, "utf8");
      const header = localHeader(name, stat.mtime);
      const entryOffset = offset;
      await write(outputStream, header);
      await write(outputStream, name);
      offset += header.length + name.length;
      let crc = 0xffffffff;
      let size = 0;
      for await (const chunk of fs.createReadStream(file)) {
        await write(outputStream, chunk);
        crc = updateCrc(crc, chunk);
        size += chunk.length;
        offset += chunk.length;
        processedBytes += chunk.length;
        onProgress?.(processedBytes);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = dataDescriptor(crc, size);
      await write(outputStream, descriptor);
      offset += descriptor.length;
      entries.push({ name, crc, size, offset: entryOffset, modified: stat.mtime });
    }

    if (entries.length > 0xffff) throw new Error("ZIP 中文件数量超过 65535 个。");
    const centralOffset = offset;
    for (const entry of entries) {
      const header = centralHeader(entry);
      await write(outputStream, header);
      await write(outputStream, entry.name);
      offset += header.length + entry.name.length;
    }
    const centralSize = offset - centralOffset;
    await write(outputStream, endRecord(entries.length, centralSize, centralOffset));
    outputStream.end();
    await once(outputStream, "close");
  } catch (error) {
    outputStream.destroy();
    await fsp.unlink(output).catch(() => {});
    throw error;
  }
}
