import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseXlsx, writeRecordsXlsx } from "./scripts/xlsx-portable.mjs";
import { createStoredZip } from "./scripts/zip-store.mjs";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const root = process.pkg ? path.dirname(process.execPath) : sourceRoot;
const configPath = path.join(root, "config.json");
const publicDir = path.join(root, "public");
const tasksRoot = path.join(root, "任务数据");
const taskIndexPath = path.join(tasksRoot, "tasks.json");
const adminConfigPath = path.join(tasksRoot, "admin.json");
const templatePath = path.join(publicDir, "凭证清单模板.xlsx");
const legacyRoot = path.join(root, "照片存储");
const legacyVouchersPath = path.join(root, "data", "vouchers.json");
const pidFile = path.join(root, ".voucher-server.pid");

function loadServerConfig() {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`无法读取 config.json：${error.message}`);
  }
}

const serverConfig = loadServerConfig();
const configuredPort = process.env.PORT ? process.env.PORT : (serverConfig.port ?? 3000);
const port = Number(configuredPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("端口配置无效：请在 config.json 中填写 1 至 65535 之间的整数。");
}
const configuredHost = process.env.HOST ? process.env.HOST : (serverConfig.host ?? "0.0.0.0");
const host = String(configuredHost).trim();
if (!host) throw new Error("监听地址配置无效：config.json 中的 host 不能为空。");
const maxBody = 100 * 1024 * 1024;
const importPreviews = new Map();
const exportJobs = new Map();
const exportQueue = [];
const adminSessions = new Map();
let exportWorkerBusy = false;
let expiryCleanupBusy = false;
let tasks = [];
let adminConfig = {};
let maxTasks = 3;
const USER_VALIDITY_HOURS = new Set([24, 48, 168]);
const ADMIN_VALIDITY_HOURS = new Set([24, 48, 168, 720]);

function createAccessToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function networkBaseUrls() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(`http://${entry.address}:${port}`);
    }
  }
  return addresses;
}

function preferredLanBaseUrl() {
  const addresses = networkBaseUrls();
  return addresses.find((address) => /\/\/(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address))
    || addresses.find((address) => !address.includes("//198.18."))
    || addresses[0]
    || `http://localhost:${port}`;
}

function safeSegment(value) {
  return String(value ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "未命名";
}

function shortOrganization(organization) {
  const value = String(organization || "未设置");
  const shortened = value
    .replace(/(?:有限责任公司|股份有限公司|有限公司).*$/, "")
    .replace(/-基准账簿$/, "")
    .trim();
  return shortened || value;
}

function recordId(record) {
  return crypto.createHash("sha1")
    .update(`${record.date}\u0000${record.organization}\u0000${record.voucher}`)
    .digest("hex")
    .slice(0, 16);
}

function prepareImportedRecords(sourceRecords, folderMode) {
  const occurrences = new Map();
  return sourceRecords.map((record) => {
    const next = { ...record, id: recordId(record) };
    if (folderMode === "flat") {
      const base = `${String(record.date).replaceAll("-", "")}-${safeSegment(record.voucher)}`;
      const index = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, index);
      next.photoFolder = index === 1 ? base : `${base}-${index}`;
    } else {
      const [year = "未设置年份", month = "未设置月份"] = String(record.date).split("-");
      const base = safeSegment(record.voucher);
      const key = `${year}/${month}/${base}`;
      const index = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, index);
      next.photoFolder = index === 1 ? base : `${base}-${index}`;
    }
    return next;
  });
}

function recordStoragePath(task, record) {
  if ((task?.folderMode || "nested") === "flat") {
    return safeSegment(record.photoFolder || `${String(record.date).replaceAll("-", "")}-${record.voucher}`);
  }
  const [year = "未设置年份", month = "未设置月份"] = String(record.date).split("-");
  return `${safeSegment(year)}/${safeSegment(month)}/${safeSegment(record.photoFolder || record.voucher)}`;
}

function taskDirectory(taskId) {
  return path.join(tasksRoot, safeSegment(taskId));
}

function recordsPath(taskId) {
  return path.join(taskDirectory(taskId), "records.json");
}

function recordDirectory(taskId, record) {
  const task = getTask(taskId);
  const folderMode = task?.folderMode || "nested";
  if (folderMode === "flat") {
    return path.join(
      taskDirectory(taskId),
      "photos",
      safeSegment(record.photoFolder || `${String(record.date).replaceAll("-", "")}-${record.voucher}`),
    );
  }
  const [year = "未设置年份", month = "未设置月份"] = String(record.date).split("-");
  return path.join(
    taskDirectory(taskId),
    "photos",
    safeSegment(year),
    safeSegment(month),
    safeSegment(record.photoFolder || record.voucher),
  );
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  try {
    await fs.rename(temp, target);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    await fs.unlink(target).catch((unlinkError) => {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    });
    await fs.rename(temp, target);
  }
}

async function saveTaskIndex() {
  await writeJsonAtomic(taskIndexPath, tasks);
}

async function loadRecords(taskId) {
  return JSON.parse(await fs.readFile(recordsPath(taskId), "utf8"));
}

async function saveRecords(taskId, records) {
  await writeJsonAtomic(recordsPath(taskId), records);
}

function legacyDateFolders(records) {
  const result = new Map();
  const groups = new Map();
  for (const record of records) {
    const key = `${record.plate || record.organization}\u0000${record.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.voucher.localeCompare(b.voucher, "zh-CN", { numeric: true }));
    sorted.forEach((record, index) => {
      result.set(record.id, sorted.length === 1 ? record.date : `${record.date}-${index + 1}`);
    });
  }
  return result;
}

async function copyLegacyPhotos(taskId, records) {
  const dateFolders = legacyDateFolders(records);
  let copied = 0;
  for (const record of records) {
    if (!record.plate) continue;
    const oldDir = path.join(
      legacyRoot,
      "按车牌日期",
      safeSegment(record.plate),
      safeSegment(dateFolders.get(record.id) || record.date),
    );
    let names = [];
    try {
      names = await fs.readdir(oldDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    const prefix = `${safeSegment(record.voucher)}_`;
    const targetDir = recordDirectory(taskId, record);
    await fs.mkdir(targetDir, { recursive: true });
    for (const name of names.filter((entry) => entry.startsWith(prefix) && /\.(jpe?g|png|webp|heic)$/i.test(entry))) {
      const source = path.join(oldDir, name);
      const target = path.join(targetDir, name);
      try {
        await fs.copyFile(source, target, 1);
        copied += 1;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  }
  return copied;
}

async function initializeTaskStore() {
  await fs.mkdir(tasksRoot, { recursive: true });
  try {
    tasks = JSON.parse(await fs.readFile(taskIndexPath, "utf8"));
    let changed = false;
    tasks = tasks.map((task) => {
      const next = { ...task };
      if (!next.accessToken) {
        next.accessToken = createAccessToken();
        changed = true;
      }
      if (!next.ownerName) {
        next.ownerName = "未填写（旧组）";
        changed = true;
      }
      if (!next.lastActivityAt) {
        next.lastActivityAt = next.createdAt;
        changed = true;
      }
      if (!next.folderMode) {
        next.folderMode = "nested";
        changed = true;
      }
      if (!Object.hasOwn(next, "expiresAt")) {
        next.expiresAt = null;
        changed = true;
      }
      return next;
    });
    if (changed) await saveTaskIndex();
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let legacy;
  try {
    legacy = JSON.parse(await fs.readFile(legacyVouchersPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    tasks = [];
    await saveTaskIndex();
    return;
  }
  const id = `task-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  const records = legacy.map((record) => ({
    ...record,
    id: record.id || recordId(record),
  }));
  const task = {
    id,
    name: "当前凭证任务",
    createdAt: new Date().toISOString(),
    legacySource: true,
    accessToken: createAccessToken(),
    ownerName: "未填写（旧组）",
    lastActivityAt: new Date().toISOString(),
    folderMode: "nested",
    expiresAt: null,
  };
  await fs.mkdir(taskDirectory(id), { recursive: true });
  await saveRecords(id, records);
  const copied = await copyLegacyPhotos(id, records);
  task.migratedPhotoCount = copied;
  tasks = [task];
  await saveTaskIndex();
}

async function initializeAdminConfig() {
  try {
    adminConfig = JSON.parse(await fs.readFile(adminConfigPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let changed = false;
  if (!adminConfig.password) {
    adminConfig.password = `admin-${crypto.randomInt(100000, 1000000)}`;
    changed = true;
  }
  if (!adminConfig.createdAt) {
    adminConfig.createdAt = new Date().toISOString();
    changed = true;
  }
  const configuredMax = Number(adminConfig.maxTasks);
  maxTasks = Number.isInteger(configuredMax) && configuredMax >= 1 && configuredMax <= 50 ? configuredMax : 3;
  if (adminConfig.maxTasks !== maxTasks) {
    adminConfig.maxTasks = maxTasks;
    changed = true;
  }
  if (adminConfig.accessToken) {
    delete adminConfig.accessToken;
    changed = true;
  }
  if (changed) await writeJsonAtomic(adminConfigPath, adminConfig);
}

async function saveAdminConfig() {
  adminConfig.maxTasks = maxTasks;
  await writeJsonAtomic(adminConfigPath, adminConfig);
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

function requireAdmin(req, res) {
  const token = cookies(req).voucher_admin;
  const expiresAt = token ? adminSessions.get(token) : 0;
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) adminSessions.delete(token);
    json(res, 401, { error: "请先输入管理员密码。" });
    return false;
  }
  adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return true;
}

async function listImages(taskId, record) {
  const dir = recordDirectory(taskId, record);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const task = getTask(taskId);
  return names
    .filter((name) => /\.(jpe?g|png|webp|heic)$/i.test(name))
    .sort()
    .map((name) => ({
      name,
      url: `/group-files/${encodeURIComponent(task?.accessToken || "")}/${encodeURIComponent(record.id)}/${encodeURIComponent(name)}`,
    }));
}

async function taskSummary(task) {
  const records = await loadRecords(task.id);
  const counts = await Promise.all(records.map(async (record) => (await listImages(task.id, record)).length));
  return {
    ...task,
    recordCount: records.length,
    completedCount: counts.filter((count) => count > 0).length,
    photoCount: counts.reduce((sum, count) => sum + count, 0),
  };
}

function getTask(taskId) {
  return tasks.find((task) => task.id === taskId);
}

function getTaskByToken(accessToken) {
  return tasks.find((task) => task.accessToken === accessToken);
}

function isTaskExpired(task, now = Date.now()) {
  if (!task?.expiresAt) return false;
  const expiresAt = Date.parse(task.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function publicTaskSummary(task) {
  const summary = await taskSummary(task);
  const sharePath = `/g/${task.accessToken}`;
  return {
    name: summary.name,
    createdAt: summary.createdAt,
    recordCount: summary.recordCount,
    completedCount: summary.completedCount,
    photoCount: summary.photoCount,
    ownerName: summary.ownerName,
    lastActivityAt: summary.lastActivityAt,
    folderMode: summary.folderMode || "nested",
    expiresAt: summary.expiresAt || null,
    sharePath,
    shareUrl: `${preferredLanBaseUrl()}${sharePath}`,
  };
}

function exportJobPayload(task, job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    readyAt: job.readyAt,
    downloadUrl: job.status === "ready"
      ? `/api/group/${encodeURIComponent(task.accessToken)}/jobs/${job.id}/download`
      : null,
  };
}

function latestExportJob(taskId) {
  return [...exportJobs.values()]
    .filter((job) => job.taskId === taskId)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

async function markTaskChanged(task) {
  await invalidateReadyExports(task.id, false);
  task.lastActivityAt = new Date().toISOString();
  await saveTaskIndex();
}

async function deleteTaskData(task) {
  const busyJob = [...exportJobs.values()].find((job) =>
    job.taskId === task.id && ["queued", "working"].includes(job.status));
  if (busyJob) throw Object.assign(new Error("该任务正在打包，请等待完成后再删除。"), { status: 409 });
  const summary = await taskSummary(task);
  await fs.rm(taskDirectory(task.id), { recursive: true, force: true });
  if (task.legacySource) {
    await Promise.all([
      fs.rm(path.join(legacyRoot, "按车牌日期"), { recursive: true, force: true }),
      fs.rm(path.join(legacyRoot, "按财务组织日期"), { recursive: true, force: true }),
      fs.rm(path.join(legacyRoot, "按凭证号"), { recursive: true, force: true }),
    ]);
  }
  for (const [jobId, job] of exportJobs.entries()) {
    if (job.taskId === task.id) exportJobs.delete(jobId);
  }
  tasks = tasks.filter((item) => item.id !== task.id);
  await saveTaskIndex();
  return summary;
}

async function purgeExpiredTasks() {
  if (expiryCleanupBusy) return;
  expiryCleanupBusy = true;
  try {
    for (const task of [...tasks]) {
      if (!isTaskExpired(task)) continue;
      try {
        await deleteTaskData(task);
        console.log(`已自动删除到期拍摄组：${task.name} (${task.id})`);
      } catch (error) {
        if (error.status !== 409) console.error(`自动删除到期拍摄组失败：${task.id}`, error);
      }
    }
  } finally {
    expiryCleanupBusy = false;
  }
}

async function getRecord(taskId, recordIdValue) {
  const records = await loadRecords(taskId);
  return { records, record: records.find((item) => item.id === recordIdValue) };
}

function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

async function readRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw Object.assign(new Error("上传内容超过 100MB"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonRequest(req) {
  const body = await readRequest(req);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("请求内容格式不正确"), { status: 400 });
  }
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index;
  while ((index = buffer.indexOf(separator, start)) !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("上传格式不正确"), { status: 400 });
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  return splitBuffer(buffer, boundary).flatMap((raw) => {
    let part = raw;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);
    if (part.subarray(-2).toString() === "--") part = part.subarray(0, -2);
    if (!part.length) return [];
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) return [];
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || "application/octet-stream";
    if (!disposition) return [];
    return [{ field: disposition[1], filename: disposition[2], type, data: body }];
  });
}

function extensionFor(file) {
  const byType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heic",
  };
  return byType[file.type.toLowerCase()] || path.extname(file.filename || "").toLowerCase();
}

function contentDisposition(filename) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function serveFile(res, filePath, options = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".heic": "image/heic",
  };
  try {
    const stat = await fs.stat(filePath);
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": options.cache ? "public, max-age=3600" : "no-cache",
      ...(options.downloadName ? { "Content-Disposition": contentDisposition(options.downloadName) } : {}),
    });
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) json(res, 500, { error: "文件读取失败" });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    json(res, error.code === "ENOENT" ? 404 : 500, { error: "文件读取失败" });
  }
}

async function recordsWithCounts(taskId) {
  const records = await loadRecords(taskId);
  const task = getTask(taskId);
  return Promise.all(records.map(async (record) => {
    const imageCount = (await listImages(taskId, record)).length;
    return {
      ...record,
      attachmentCount: imageCount,
      imageCount,
      storageFolder: `${safeSegment(record.voucher)}_${safeSegment(shortOrganization(record.organization))}`,
      storagePath: recordStoragePath(task, record),
    };
  }));
}

async function createRecordsWorkbook(task) {
  const exportDir = path.join(taskDirectory(task.id), "exports");
  await fs.mkdir(exportDir, { recursive: true });
  const records = await recordsWithCounts(task.id);
  const outputPath = path.join(exportDir, `${safeSegment(task.name)}_本次记录.xlsx`);
  await writeRecordsXlsx({ taskName: task.name, records }, outputPath);
  return outputPath;
}

async function walkFiles(dir) {
  const result = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

async function buildZip(job) {
  const task = getTask(job.taskId);
  if (!task) throw new Error("任务不存在");
  job.status = "working";
  job.stage = "正在生成记录表";
  job.progress = 3;
  const taskDir = taskDirectory(task.id);
  const workbookPath = await createRecordsWorkbook(task);
  const manifestPath = path.join(taskDir, "本次记录.xlsx");
  await fs.copyFile(workbookPath, manifestPath);
  try {
    const photoFiles = await walkFiles(path.join(taskDir, "photos"));
    const files = [...photoFiles, manifestPath];
    const stats = await Promise.all(files.map((file) => fs.stat(file)));
    const totalBytes = Math.max(1, stats.reduce((sum, stat) => sum + stat.size, 0));
    const exportDir = path.join(taskDir, "exports");
    await fs.mkdir(exportDir, { recursive: true });
    const output = path.join(exportDir, `${safeSegment(task.name)}_照片_${Date.now()}.zip`);
    await fs.unlink(output).catch(() => {});
    job.stage = exportQueue.length ? "正在打包（其他任务等待中）" : "正在打包照片";
    await createStoredZip({
      files,
      rootDir: taskDir,
      output,
      onProgress: (processedBytes) => {
        job.progress = Math.min(96, Math.round(5 + (processedBytes / totalBytes) * 91));
      },
    });
    job.status = "ready";
    job.stage = "打包完成";
    job.progress = 100;
    job.filePath = output;
    job.fileName = path.basename(output);
    job.readyAt = Date.now();
    task.lastExport = {
      jobId: job.id,
      fileName: job.fileName,
      relativePath: path.relative(taskDirectory(task.id), output),
      createdAt: job.createdAt,
      readyAt: job.readyAt,
    };
    await saveTaskIndex();
  } finally {
    await fs.unlink(manifestPath).catch(() => {});
  }
}

async function pumpExportQueue() {
  if (exportWorkerBusy) return;
  const job = exportQueue.shift();
  if (!job) return;
  exportWorkerBusy = true;
  try {
    await buildZip(job);
  } catch (error) {
    job.status = "error";
    job.stage = "打包失败";
    job.error = error.message || "照片包生成失败。";
  } finally {
    exportWorkerBusy = false;
    pumpExportQueue();
  }
}

async function createZipJob(taskId) {
  const existing = [...exportJobs.values()].find((job) =>
    job.taskId === taskId && ["queued", "working"].includes(job.status));
  if (existing) return existing;
  await invalidateReadyExports(taskId, false);
  const task = getTask(taskId);
  if (task) task.lastActivityAt = new Date().toISOString();
  await saveTaskIndex();
  const job = {
    id: crypto.randomUUID(),
    taskId,
    status: "queued",
    stage: exportWorkerBusy ? "排队中" : "准备打包",
    progress: 0,
    createdAt: Date.now(),
  };
  exportJobs.set(job.id, job);
  exportQueue.push(job);
  pumpExportQueue();
  return job;
}

async function invalidateReadyExports(taskId, save = true) {
  for (const [jobId, job] of exportJobs.entries()) {
    if (job.taskId !== taskId || job.status !== "ready") continue;
    if (job.filePath) fs.unlink(job.filePath).catch(() => {});
    exportJobs.delete(jobId);
  }
  const task = getTask(taskId);
  if (task?.lastExport) delete task.lastExport;
  if (save) await saveTaskIndex();
}

async function restorePersistentExports() {
  let changed = false;
  for (const task of tasks) {
    if (!task.lastExport?.relativePath || !task.lastExport?.jobId) continue;
    const filePath = path.join(taskDirectory(task.id), task.lastExport.relativePath);
    if (!isInside(taskDirectory(task.id), filePath)) {
      delete task.lastExport;
      changed = true;
      continue;
    }
    try {
      await fs.access(filePath);
      exportJobs.set(task.lastExport.jobId, {
        id: task.lastExport.jobId,
        taskId: task.id,
        status: "ready",
        stage: "打包完成",
        progress: 100,
        createdAt: task.lastExport.createdAt,
        readyAt: task.lastExport.readyAt,
        filePath,
        fileName: task.lastExport.fileName,
      });
    } catch {
      delete task.lastExport;
      changed = true;
    }
  }
  if (changed) await saveTaskIndex();
}

await initializeTaskStore();
await initializeAdminConfig();
await restorePersistentExports();
await purgeExpiredTasks();
const expiryCleanupTimer = setInterval(() => {
  purgeExpiredTasks().catch((error) => console.error("到期拍摄组清理失败", error));
}, 30 * 1000);
expiryCleanupTimer.unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "GET" && url.pathname === "/api/health") {
      await purgeExpiredTasks();
      return json(res, 200, { ok: true, tasks: tasks.length, maxTasks });
    }

    if (req.method === "GET" && url.pathname === "/api/template") {
      return serveFile(res, templatePath, { downloadName: "凭证清单模板.xlsx" });
    }

    if (req.method === "GET" && url.pathname === "/api/capacity") {
      await purgeExpiredTasks();
      return json(res, 200, {
        canCreate: tasks.length < maxTasks,
        availableSlots: Math.max(0, maxTasks - tasks.length),
        maxTasks,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/import/preview") {
      const body = await readRequest(req);
      const file = parseMultipart(body, req.headers["content-type"])
        .find((item) => ["list", "file"].includes(item.field) && item.filename);
      if (!file) return json(res, 400, { error: "请选择要导入的 Excel 清单" });
      if (!/\.xlsx$/i.test(file.filename)) return json(res, 415, { error: "请使用 .xlsx 格式的清单" });
      const tempDir = path.join(tasksRoot, ".imports");
      await fs.mkdir(tempDir, { recursive: true });
      const token = crypto.randomUUID();
      const inputPath = path.join(tempDir, `${token}.xlsx`);
      await fs.writeFile(inputPath, file.data);
      try {
        const preview = await parseXlsx(inputPath);
        importPreviews.set(token, { ...preview, createdAt: Date.now() });
        setTimeout(() => importPreviews.delete(token), 30 * 60 * 1000);
        return json(res, 200, {
          token,
          recordCount: preview.records.length,
          errors: preview.errors,
          sample: preview.records.slice(0, 8),
        });
      } finally {
        await fs.unlink(inputPath).catch(() => {});
      }
    }

    if (req.method === "POST" && url.pathname === "/api/tasks") {
      await purgeExpiredTasks();
      if (tasks.length >= maxTasks) return json(res, 409, { error: `当前最多允许同时进行 ${maxTasks} 个任务，请先清除一个已完成任务。` });
      const payload = await readJsonRequest(req);
      const previewToken = payload.importToken || payload.token;
      const preview = importPreviews.get(previewToken);
      if (!preview) return json(res, 400, { error: "导入预览已过期，请重新选择清单。" });
      if (preview.errors.length) return json(res, 400, { error: "清单仍有错误，不能创建任务。" });
      const name = String(payload.name || "").trim();
      if (!name) return json(res, 400, { error: "请输入任务名称。" });
      const ownerName = String(payload.ownerName || "").trim();
      if (!ownerName) return json(res, 400, { error: "请输入使用人姓名。" });
      const folderMode = payload.folderMode === "flat" ? "flat" : "nested";
      const validityHours = Number(payload.validityHours);
      const normalizedValidityHours = USER_VALIDITY_HOURS.has(validityHours) ? validityHours : 24;
      const now = Date.now();
      const taskId = `task-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
      const records = prepareImportedRecords(preview.records, folderMode);
      const task = {
        id: taskId,
        name: name.slice(0, 40),
        createdAt: new Date(now).toISOString(),
        legacySource: false,
        accessToken: createAccessToken(),
        ownerName: ownerName.slice(0, 30),
        lastActivityAt: new Date(now).toISOString(),
        folderMode,
        expiresAt: new Date(now + normalizedValidityHours * 60 * 60 * 1000).toISOString(),
      };
      await fs.mkdir(taskDirectory(taskId), { recursive: true });
      await saveRecords(taskId, records);
      tasks.push(task);
      await saveTaskIndex();
      importPreviews.delete(previewToken);
      return json(res, 201, await publicTaskSummary(task));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const payload = await readJsonRequest(req);
      const provided = Buffer.from(String(payload.password || ""));
      const expected = Buffer.from(String(adminConfig.password || ""));
      const valid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
      if (!valid) return json(res, 401, { error: "管理员密码不正确。" });
      const token = createAccessToken();
      adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
      return json(res, 200, { ok: true }, {
        "Set-Cookie": `voucher_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      const token = cookies(req).voucher_admin;
      if (token) adminSessions.delete(token);
      return json(res, 200, { ok: true }, {
        "Set-Cookie": "voucher_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/session") {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, { authenticated: true });
    }

    if (parts[0] === "api" && parts[1] === "admin") {
      if (!requireAdmin(req, res)) return;
      await purgeExpiredTasks();

      if (req.method === "GET" && parts[2] === "groups" && parts.length === 3) {
        const groups = await Promise.all(tasks.map(async (task) => {
          const summary = await taskSummary(task);
          return {
            id: task.id,
            name: task.name,
            ownerName: task.ownerName,
            createdAt: task.createdAt,
            lastActivityAt: task.lastActivityAt,
            recordCount: summary.recordCount,
            completedCount: summary.completedCount,
            photoCount: summary.photoCount,
            folderMode: task.folderMode || "nested",
            expiresAt: task.expiresAt || null,
            shareUrl: `${preferredLanBaseUrl()}/g/${task.accessToken}`,
            exportJob: exportJobPayload(task, latestExportJob(task.id)),
          };
        }));
        return json(res, 200, { groups, maxTasks, availableSlots: Math.max(0, maxTasks - tasks.length) });
      }

      if (req.method === "PUT" && parts[2] === "settings" && parts.length === 3) {
        const payload = await readJsonRequest(req);
        const nextMax = Number(payload.maxTasks);
        if (!Number.isInteger(nextMax) || nextMax < 1 || nextMax > 50) {
          return json(res, 400, { error: "组数必须是 1 到 50 之间的整数。" });
        }
        maxTasks = nextMax;
        await saveAdminConfig();
        return json(res, 200, {
          ok: true,
          maxTasks,
          activeGroups: tasks.length,
          availableSlots: Math.max(0, maxTasks - tasks.length),
        });
      }

      if (req.method === "PUT" && parts[2] === "groups" && parts[3] && parts[4] === "expiry") {
        const task = getTask(parts[3]);
        if (!task) return json(res, 404, { error: "拍摄组不存在或已到期自动删除" });
        const payload = await readJsonRequest(req);
        if (payload.mode === "permanent") {
          task.expiresAt = null;
        } else {
          const hours = Number(payload.hours);
          if (!ADMIN_VALIDITY_HOURS.has(hours)) {
            return json(res, 400, { error: "请选择 24 小时、48 小时、7 天、30 天或长期有效。" });
          }
          task.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
        }
        await saveTaskIndex();
        return json(res, 200, { ok: true, expiresAt: task.expiresAt });
      }

      if (req.method === "DELETE" && parts[2] === "groups" && parts[3]) {
        const payload = await readJsonRequest(req);
        if (payload.confirmation !== "DELETE") {
          return json(res, 400, { error: "请输入大写 DELETE 确认删除。" });
        }
        const task = getTask(parts[3]);
        if (!task) return json(res, 404, { error: "拍摄组不存在或已被删除" });
        const deleted = await deleteTaskData(task);
        return json(res, 200, { ok: true, deleted: { name: deleted.name, ownerName: deleted.ownerName } });
      }
    }

    if (parts[0] === "api" && parts[1] === "group" && parts[2]) {
      const task = getTaskByToken(parts[2]);
      if (!task) return json(res, 404, { error: "拍摄组地址无效或已被清除" });
      if (isTaskExpired(task)) {
        purgeExpiredTasks().catch((error) => console.error("到期拍摄组清理失败", error));
        return json(res, 410, { error: "这个拍摄组已到期，记录和附件已自动清除。" });
      }

      if (req.method === "GET" && parts.length === 3) {
        return json(res, 200, await publicTaskSummary(task));
      }

      if (req.method === "GET" && parts[3] === "records" && parts.length === 4) {
        return json(res, 200, await recordsWithCounts(task.id));
      }

      if (req.method === "GET" && parts[3] === "export-records") {
        const output = await createRecordsWorkbook(task);
        return serveFile(res, output, { downloadName: `${task.name}_本次记录.xlsx` });
      }

      if (req.method === "POST" && parts[3] === "export-photos") {
        const job = await createZipJob(task.id);
        return json(res, 202, { id: job.id, jobId: job.id, status: job.status, stage: job.stage, progress: job.progress });
      }

      if (req.method === "GET" && parts[3] === "export-status" && parts.length === 4) {
        return json(res, 200, { job: exportJobPayload(task, latestExportJob(task.id)) });
      }

      if (req.method === "GET" && parts[3] === "jobs" && parts[4]) {
        const job = exportJobs.get(parts[4]);
        if (!job || job.taskId !== task.id) return json(res, 404, { error: "打包任务不存在或已过期" });
        if (parts[5] === "download") {
          if (job.status !== "ready" || !job.filePath) return json(res, 404, { error: "压缩包尚未完成或内容已更新" });
          return serveFile(res, job.filePath, { downloadName: job.fileName });
        }
        if (parts.length === 5) {
          return json(res, 200, exportJobPayload(task, job));
        }
      }

      if (req.method === "DELETE" && parts.length === 3) {
        const payload = await readJsonRequest(req);
        if ((payload.confirmation || payload.confirm) !== "OK") return json(res, 400, { error: "请输入大写 OK 确认清除。" });
        const summary = await deleteTaskData(task);
        return json(res, 200, { ok: true, deleted: summary });
      }

      if (parts[3] === "records" && parts[4] && parts[5] === "images") {
        const { record } = await getRecord(task.id, parts[4]);
        if (!record) return json(res, 404, { error: "凭证记录不存在" });

        if (req.method === "GET" && parts.length === 6) {
          return json(res, 200, await listImages(task.id, record));
        }

        if (req.method === "POST" && parts.length === 6) {
          const body = await readRequest(req);
          const files = parseMultipart(body, req.headers["content-type"])
            .filter((item) => item.field === "photos" && item.filename);
          if (!files.length) return json(res, 400, { error: "没有选择照片" });
          const dir = recordDirectory(task.id, record);
          await fs.mkdir(dir, { recursive: true });
          for (const file of files) {
            const ext = extensionFor(file);
            if (![".jpg", ".jpeg", ".png", ".webp", ".heic"].includes(ext) || !file.type.startsWith("image/")) {
              return json(res, 415, { error: `不支持的图片格式：${file.filename}` });
            }
            if (file.data.length > 20 * 1024 * 1024) {
              return json(res, 413, { error: `单张照片不能超过 20MB：${file.filename}` });
            }
            const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
            const name = `${safeSegment(record.voucher)}_${stamp}_${crypto.randomBytes(3).toString("hex")}${ext === ".jpeg" ? ".jpg" : ext}`;
            await fs.writeFile(path.join(dir, name), file.data, { flag: "wx" });
          }
          await markTaskChanged(task);
          return json(res, 201, { ok: true, images: await listImages(task.id, record) });
        }

        if (req.method === "PUT" && parts[6]) {
          const originalName = path.basename(parts[6]);
          const dir = recordDirectory(task.id, record);
          const originalTarget = path.join(dir, originalName);
          if (!isInside(taskDirectory(task.id), originalTarget)) return json(res, 403, { error: "无权访问" });
          try {
            await fs.access(originalTarget);
          } catch {
            return json(res, 404, { error: "照片不存在或已被删除" });
          }
          const body = await readRequest(req);
          const file = parseMultipart(body, req.headers["content-type"])
            .find((item) => item.field === "photo" && item.filename);
          if (!file) return json(res, 400, { error: "没有收到旋转后的照片" });
          const ext = extensionFor(file);
          if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext) || !file.type.startsWith("image/")) {
            return json(res, 415, { error: "旋转后的图片格式不受支持" });
          }
          const base = path.basename(originalName, path.extname(originalName)).replace(/_r\d+$/, "");
          const normalizedExt = ext === ".jpeg" ? ".jpg" : ext;
          const newName = `${base}_r${Date.now()}${normalizedExt}`;
          await fs.writeFile(path.join(dir, newName), file.data, { flag: "wx" });
          await fs.unlink(originalTarget);
          await markTaskChanged(task);
          return json(res, 200, { ok: true, name: newName, images: await listImages(task.id, record) });
        }

        if (req.method === "DELETE" && parts[6]) {
          const target = path.join(recordDirectory(task.id, record), path.basename(parts[6]));
          if (!isInside(taskDirectory(task.id), target)) return json(res, 403, { error: "无权访问" });
          await fs.unlink(target);
          await markTaskChanged(task);
          return json(res, 200, { ok: true, images: await listImages(task.id, record) });
        }
      }
    }

    if (req.method === "GET" && parts[0] === "group-files" && parts[1] && parts[2] && parts[3]) {
      const task = getTaskByToken(parts[1]);
      if (!task) return json(res, 404, { error: "照片地址无效" });
      if (isTaskExpired(task)) {
        purgeExpiredTasks().catch((error) => console.error("到期拍摄组清理失败", error));
        return json(res, 410, { error: "拍摄组已到期，照片已自动清除。" });
      }
      const { record } = await getRecord(task.id, parts[2]);
      if (!record) return json(res, 404, { error: "凭证记录不存在" });
      const filePath = path.join(recordDirectory(task.id, record), path.basename(parts[3]));
      if (!isInside(taskDirectory(task.id), filePath)) return json(res, 403, { error: "无权访问" });
      return serveFile(res, filePath, { cache: true });
    }

    if (parts[0] === "api") {
      return json(res, 404, { error: "接口不存在" });
    }

    if (req.method === "GET") {
      const requested = parts[0] === "admin"
        ? "admin.html"
        : url.pathname === "/" || (parts[0] === "g" && parts[1])
          ? "index.html"
          : url.pathname.slice(1);
      const filePath = path.join(publicDir, requested);
      if (isInside(publicDir, filePath)) return serveFile(res, filePath);
    }

    json(res, 404, { error: "页面不存在" });
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.message || "服务器发生错误" });
  }
});

server.listen(port, host, () => {
  writeFileSync(pidFile, String(process.pid));
  console.log("凭证照片归档系统已启动");
  console.log(`本机访问：http://localhost:${port}`);
  for (const address of networkBaseUrls()) console.log(`手机访问：${address}`);
  console.log(`管理入口：http://localhost:${port}/admin`);
  console.log(`管理员密码：${adminConfig.password}`);
  console.log(`任务目录：${tasksRoot}`);
});

process.on("exit", () => {
  try {
    if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile);
  } catch {
    // PID file may have been removed by the service switch.
  }
});
