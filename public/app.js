import { canApplyRecordResponse, recordsNeedRefresh } from "./sync-state.js";

const $ = (selector) => document.querySelector(selector);
const enc = encodeURIComponent;
const pathToken = /^\/g\/([^/]+)\/?$/.exec(location.pathname)?.[1] || null;
const state = {
  accessToken: pathToken,
  task: null,
  vouchers: [],
  filter: "all",
  year: "all",
  query: "",
  sortOrder: "desc",
  selected: null,
  previewImage: null,
  importToken: null,
  exportJob: null,
  exportPollTimer: null,
  expiryTimer: null,
  expiryRefreshTriggered: false,
  syncTimer: null,
  syncInFlight: false,
  recordsSyncedAt: null,
};
const GROUP_SYNC_INTERVAL = 2000;
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const beijingDateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const groupApi = (suffix = "") => `/api/group/${enc(state.accessToken)}${suffix}`;

async function api(url, options) {
  const response = await fetch(url, options);
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : {};
  if (!response.ok) {
    const error = new Error(body.error || "操作失败");
    error.status = response.status;
    throw error;
  }
  return body;
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 2600);
}

function hasAmount(item) {
  return item.amount !== null && item.amount !== undefined && item.amount !== "" && Number.isFinite(Number(item.amount));
}
function openLayer(id) { $(`#${id}`).hidden = false; }
function closeLayer(id) { $(`#${id}`).hidden = true; }

function renderTaskHeader() {
  $("#task-name").textContent = state.task?.name || "拍摄组";
  $("#task-owner").textContent = state.task?.ownerName ? `使用人：${state.task.ownerName}` : "";
  $("#share-address").value = state.task?.shareUrl || location.href.replace(/\/$/, "");
}

function renderExpiryCountdown() {
  const box = $("#expiry-countdown");
  const value = $("#expiry-countdown-value");
  const label = $("#expiry-countdown-label");
  if (!state.task) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!state.task.expiresAt) {
    box.dataset.status = "permanent";
    value.textContent = "长期有效";
    label.textContent = "管理员已设置";
    return;
  }
  const remaining = Date.parse(state.task.expiresAt) - Date.now();
  if (remaining <= 0) {
    box.dataset.status = "expired";
    value.textContent = "已到期";
    label.textContent = "正在自动清除";
    if (!state.expiryRefreshTriggered) {
      state.expiryRefreshTriggered = true;
      setTimeout(() => location.reload(), 1200);
    }
    return;
  }
  box.dataset.status = remaining <= 60 * 60 * 1000 ? "urgent" : "active";
  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  value.textContent = `${days ? `${days}天 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  label.textContent = "有效期倒计时";
}

function startExpiryCountdown() {
  clearInterval(state.expiryTimer);
  renderExpiryCountdown();
  state.expiryTimer = setInterval(renderExpiryCountdown, 1000);
}

function exportTime(value) {
  if (!value) return "";
  return beijingDateTime.format(new Date(value));
}

function renderExportStatus() {
  const job = state.exportJob;
  const bar = $("#export-status-bar");
  const quickDownload = $("#quick-download-zip");
  if (!job) {
    bar.hidden = true;
    $("#export-photos").textContent = "导出全部照片";
    return;
  }

  bar.hidden = false;
  bar.dataset.status = job.status;
  quickDownload.hidden = true;
  $("#open-export-status").hidden = false;
  if (["queued", "working"].includes(job.status)) {
    $("#export-status-title").textContent = "照片包正在后台处理";
    $("#export-status-detail").textContent = `${job.stage || "正在排队"} · ${job.progress || 0}%`;
    $("#open-export-status").textContent = "查看进度";
    $("#export-photos").textContent = "查看打包进度";
  } else if (job.status === "ready") {
    $("#export-status-title").textContent = "照片包已准备好";
    $("#export-status-detail").textContent = job.readyAt ? `完成于 ${exportTime(job.readyAt)}` : "可以随时下载";
    $("#open-export-status").textContent = "查看详情";
    quickDownload.href = job.downloadUrl;
    quickDownload.hidden = false;
    $("#export-photos").textContent = "查看照片包";
  } else {
    $("#export-status-title").textContent = "照片包生成失败";
    $("#export-status-detail").textContent = job.error || "请重新打包";
    $("#open-export-status").textContent = "查看详情";
    $("#export-photos").textContent = "重新导出照片";
  }
}

function updateCounts() {
  const done = state.vouchers.filter((item) => item.imageCount > 0).length;
  $("#count-all").textContent = state.vouchers.length;
  $("#count-done").textContent = done;
  $("#count-pending").textContent = state.vouchers.length - done;
}

function updateYears() {
  const years = [...new Set(state.vouchers.map((item) => item.date.slice(0, 4)))].sort().reverse();
  $("#year").innerHTML = `<option value="all">全部年份</option>${years.map((year) => `<option value="${year}">${year} 年</option>`).join("")}`;
  if (!years.includes(state.year)) state.year = "all";
  $("#year").value = state.year;
}

function filteredVouchers() {
  const query = state.query.trim().toLowerCase();
  return state.vouchers
    .filter((item) => state.filter === "all" || (state.filter === "done") === (item.imageCount > 0))
    .filter((item) => state.year === "all" || item.date.startsWith(state.year))
    .filter((item) => !query || [item.voucher, item.organization].some((text) => String(text || "").toLowerCase().includes(query)))
    .sort((a, b) => (state.sortOrder === "desc" ? -1 : 1) *
      (a.date.localeCompare(b.date) || a.voucher.localeCompare(b.voucher, "zh-CN", { numeric: true })));
}

function render() {
  renderTaskHeader();
  renderExportStatus();
  updateCounts();
  const items = filteredVouchers();
  $("#empty").hidden = items.length > 0;
  $("#voucher-list").innerHTML = items.map((item, index) => `
    <button class="voucher ${item.imageCount ? "done" : ""}" data-id="${escapeHtml(item.id)}" style="animation-delay:${Math.min(index * 24, 240)}ms">
      <span class="voucher-status">${item.imageCount ? "✓" : "待"}</span>
      <span class="voucher-copy">
        <span class="voucher-title"><strong>${escapeHtml(item.voucher)}</strong></span>
        <span class="voucher-sub"><span>${escapeHtml(item.date)}</span><i></i><span>${escapeHtml(item.organization)}</span></span>
      </span>
      <span class="voucher-side">
        ${hasAmount(item) ? `<strong>${money.format(item.amount)}</strong>` : ""}
        <span>${item.imageCount ? `${item.imageCount} 张照片` : "未上传"}</span>
      </span>
    </button>`).join("");
  document.querySelectorAll(".voucher").forEach((button) =>
    button.addEventListener("click", () => openVoucher(button.dataset.id)));
}

async function loadGroup() {
  const marker = await api(groupApi("/sync"));
  const [task, vouchers, exportStatus] = await Promise.all([
    api(groupApi()),
    api(groupApi("/records")),
    api(groupApi("/export-status")),
  ]);
  state.task = task;
  state.vouchers = vouchers;
  state.recordsSyncedAt = marker.lastActivityAt;
  state.exportJob = exportStatus.job;
  document.body.classList.remove("landing-mode", "landing-mode-error");
  $("#landing").hidden = true;
  $("#group-main").hidden = false;
  startExpiryCountdown();
  updateYears();
  render();
  scheduleExportPoll();
  scheduleGroupSync();
  showCreatedLinkReminder();
}

async function loadLanding() {
  document.body.classList.add("landing-mode");
  document.body.classList.remove("landing-mode-error");
  $("#admin-entry").hidden = false;
  $("#landing").hidden = false;
  $("#group-main").hidden = true;
  clearInterval(state.expiryTimer);
  clearTimeout(state.syncTimer);
  $("#expiry-countdown").hidden = true;
  try {
    const capacity = await api("/api/capacity");
    $("#landing-create").disabled = !capacity.canCreate;
    $("#capacity-note").textContent = capacity.canCreate
      ? `当前还可建立 ${capacity.availableSlots} 个独立组。`
      : `当前已达到管理员设定的 ${capacity.maxTasks} 个组，请先清除一个已完成组。`;
  } catch (error) {
    $("#capacity-note").textContent = error.message;
  }
}

function updateRotationPreview() {
  const rotation = state.previewImage?.rotation || 0;
  $("#preview-image").style.transform = `rotate(${rotation}deg)`;
  $("#preview-image").classList.toggle("sideways", Math.abs(rotation) % 180 === 90);
  $("#rotation-label").textContent = `${rotation}°`;
  $("#save-rotation").disabled = rotation === 0;
}

function openPreview(url, name) {
  state.previewImage = { url, name, rotation: 0 };
  $("#preview-image").src = url;
  updateRotationPreview();
  $("#preview").hidden = false;
}

function closePreview() {
  $("#preview").hidden = true;
  $("#preview-image").removeAttribute("src");
  $("#preview-image").removeAttribute("style");
  $("#preview-image").classList.remove("sideways");
  state.previewImage = null;
}

async function loadDrawable(blob) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(blob); } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}

async function createRotatedBlob(url, degrees) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("原照片读取失败");
  const sourceBlob = await response.blob();
  const drawable = await loadDrawable(sourceBlob);
  const width = drawable.naturalWidth || drawable.width;
  const height = drawable.naturalHeight || drawable.height;
  const sideways = Math.abs(degrees) % 180 === 90;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? height : width;
  canvas.height = sideways ? width : height;
  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(degrees * Math.PI / 180);
  context.drawImage(drawable, -width / 2, -height / 2, width, height);
  drawable.close?.();
  const type = sourceBlob.type === "image/png" ? "image/png" : sourceBlob.type === "image/webp" ? "image/webp" : "image/jpeg";
  const result = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.94));
  if (!result) throw new Error("手机浏览器无法生成旋转后的照片");
  return result;
}

async function saveRotation() {
  if (!state.selected || !state.previewImage?.rotation) return;
  const recordId = state.selected.id;
  const previewImage = { ...state.previewImage };
  const button = $("#save-rotation");
  button.disabled = true;
  button.textContent = "保存中…";
  try {
    const rotated = await createRotatedBlob(previewImage.url, previewImage.rotation);
    const ext = rotated.type === "image/png" ? ".png" : rotated.type === "image/webp" ? ".webp" : ".jpg";
    const form = new FormData();
    form.append("photo", rotated, `rotated${ext}`);
    await api(groupApi(`/records/${enc(recordId)}/images/${enc(previewImage.name)}`), { method: "PUT", body: form });
    if (state.selected?.id === recordId && state.previewImage?.name === previewImage.name) closePreview();
    await refreshImages(recordId);
    await refreshTaskStats();
    toast("旋转后的照片已保存；下次导出会重新打包");
  } catch (error) { toast(error.message); }
  finally { button.textContent = "保存旋转"; }
}

function askDeleteConfirmation() {
  openLayer("confirm-layer");
  return new Promise((resolve) => { state.deleteResolver = resolve; });
}

function resolveDeleteConfirmation(value) {
  closeLayer("confirm-layer");
  state.deleteResolver?.(value);
  state.deleteResolver = null;
}

async function refreshImages(recordId = state.selected?.id) {
  if (!recordId) return false;
  const images = await api(groupApi(`/records/${enc(recordId)}/images`));
  if (!canApplyRecordResponse(recordId, state.selected?.id)) return false;
  state.selected.imageCount = images.length;
  const backing = state.vouchers.find((item) => item.id === recordId);
  if (backing) backing.imageCount = images.length;
  $("#photo-count").textContent = `${images.length} 张`;
  $("#photo-grid").innerHTML = images.map((image) => `
    <figure class="photo-card">
      <button class="photo-preview" data-url="${escapeHtml(image.url)}" data-name="${escapeHtml(image.name)}" aria-label="预览照片">
        <img src="${escapeHtml(image.url)}" alt="凭证照片缩略图" loading="lazy" />
      </button>
      <button class="photo-delete" data-name="${escapeHtml(image.name)}">删除</button>
    </figure>`).join("");
  document.querySelectorAll(".photo-preview").forEach((button) =>
    button.addEventListener("click", () => openPreview(button.dataset.url, button.dataset.name)));
  document.querySelectorAll(".photo-delete").forEach((button) => button.addEventListener("click", async () => {
    if (!await askDeleteConfirmation()) return;
    try {
      await api(groupApi(`/records/${enc(recordId)}/images/${enc(button.dataset.name)}`), { method: "DELETE" });
      await refreshImages(recordId);
      await refreshTaskStats();
      toast("照片已删除；旧照片包已失效");
    } catch (error) { toast(error.message); }
  }));
  render();
  return true;
}

async function refreshTaskStats() {
  const [task, exportStatus] = await Promise.all([
    api(groupApi()),
    api(groupApi("/export-status")),
  ]);
  state.task = task;
  state.exportJob = exportStatus.job;
  renderTaskHeader();
  renderExportStatus();
  scheduleExportPoll();
}

function scheduleGroupSync(delay = GROUP_SYNC_INTERVAL) {
  clearTimeout(state.syncTimer);
  if (!state.accessToken || !state.task) return;
  state.syncTimer = setTimeout(async () => {
    if (!document.hidden) await syncGroupChanges();
    scheduleGroupSync();
  }, delay);
}

async function syncGroupChanges() {
  if (state.syncInFlight || !state.task) return;
  state.syncInFlight = true;
  try {
    const marker = await api(groupApi("/sync"));
    const contentChanged = recordsNeedRefresh(marker.lastActivityAt, state.recordsSyncedAt);
    const expiryChanged = marker.expiresAt !== state.task.expiresAt;
    if (!contentChanged && !expiryChanged) return;

    if (contentChanged) {
      const selectedIdAtStart = state.selected?.id || null;
      const refreshMarker = marker.lastActivityAt;
      const [task, vouchers, exportStatus] = await Promise.all([
        api(groupApi()),
        api(groupApi("/records")),
        api(groupApi("/export-status")),
      ]);
      const currentSelectedId = state.selected?.id || null;
      state.task = task;
      state.vouchers = vouchers;
      state.recordsSyncedAt = refreshMarker;
      state.exportJob = exportStatus.job;
      state.selected = currentSelectedId
        ? state.vouchers.find((item) => item.id === currentSelectedId) || null
        : null;
      updateYears();
      scheduleExportPoll();
      if (currentSelectedId && !state.selected) {
        closeVoucher();
      } else if (selectedIdAtStart && currentSelectedId === selectedIdAtStart && state.selected) {
        await refreshImages();
      } else {
        render();
      }
    } else {
      state.task.expiresAt = marker.expiresAt;
      renderExpiryCountdown();
    }
  } catch (error) {
    if ([404, 410].includes(error.status)) {
      state.task = null;
      clearTimeout(state.syncTimer);
      location.reload();
    }
  } finally {
    state.syncInFlight = false;
  }
}

async function openVoucher(id) {
  state.selected = state.vouchers.find((item) => item.id === id);
  if (!state.selected) return;
  const item = state.selected;
  $("#sheet-date").textContent = item.date;
  $("#sheet-title").textContent = item.voucher;
  $("#sheet-meta").innerHTML = `
    <div class="meta-item"><span>日期</span><strong>${escapeHtml(item.date)}</strong></div>
    <div class="meta-item"><span>凭证号</span><strong>${escapeHtml(item.voucher)}</strong></div>
    <div class="meta-item ${hasAmount(item) ? "" : "wide"}"><span>财务组织</span><strong>${escapeHtml(item.organization)}</strong></div>
    ${hasAmount(item) ? `<div class="meta-item"><span>总金额</span><strong>${money.format(item.amount)}</strong></div>` : ""}`;
  $("#storage-note").textContent = `存储位置：${item.storagePath || `${item.date}/${item.storageFolder}`}/`;
  $("#backdrop").hidden = false;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  try { await refreshImages(item.id); } catch (error) { toast(error.message); }
}

function closeVoucher() {
  $("#backdrop").hidden = true;
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
  state.selected = null;
}

async function uploadPhotos(files, label) {
  if (!state.selected || !files.length) return;
  const recordId = state.selected.id;
  const form = new FormData();
  [...files].forEach((file) => form.append("photos", file));
  const span = label.querySelector("span");
  const original = span.textContent;
  label.classList.add("loading");
  span.textContent = `正在上传 ${files.length} 张…`;
  try {
    await api(groupApi(`/records/${enc(recordId)}/images`), { method: "POST", body: form });
    await refreshImages(recordId);
    await refreshTaskStats();
    toast(`已上传 ${files.length} 张；需要调整方向可点照片旋转`);
  } catch (error) { toast(error.message); }
  finally {
    label.classList.remove("loading");
    span.textContent = original;
    label.querySelector("input").value = "";
  }
}

function resetImport() {
  state.importToken = null;
  $("#import-name").value = "";
  $("#owner-name").value = "";
  document.querySelector('input[name="folder-mode"][value="nested"]').checked = true;
  document.querySelector('input[name="validity-hours"][value="24"]').checked = true;
  $("#import-file").value = "";
  $("#import-file-label").textContent = "选择填写好的 Excel";
  $("#import-preview").hidden = true;
  $("#create-task").hidden = true;
  $("#preview-import").hidden = false;
}

function openImport() {
  resetImport();
  openLayer("import-layer");
}

async function previewImport() {
  const file = $("#import-file").files[0];
  if (!file) return toast("请先选择 Excel 清单");
  const button = $("#preview-import");
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/import/preview", { method: "POST", body: form });
    state.importToken = result.token;
    const errorHtml = result.errors.length
      ? `<div class="import-errors">${result.errors.map((error) => `<p>${escapeHtml(error)}</p>`).join("")}</div>`
      : "";
    $("#import-preview").innerHTML = `
      <strong>${result.recordCount} 条可导入记录</strong>${errorHtml}
      <p>${result.sample.map((row) => `${escapeHtml(row.date)}　${escapeHtml(row.voucher)}　${escapeHtml(row.organization)}`).join("<br>")}</p>`;
    $("#import-preview").hidden = false;
    $("#create-task").hidden = result.errors.length > 0 || result.recordCount === 0;
    $("#preview-import").hidden = !$("#create-task").hidden;
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "读取清单"; }
}

async function createTask() {
  const name = $("#import-name").value.trim();
  if (!name) return toast("请填写拍摄组名称");
  const ownerName = $("#owner-name").value.trim();
  if (!ownerName) return toast("请填写使用人姓名");
  const folderMode = document.querySelector('input[name="folder-mode"]:checked')?.value || "nested";
  const validityHours = Number(document.querySelector('input[name="validity-hours"]:checked')?.value || 24);
  const button = $("#create-task");
  button.disabled = true;
  try {
    const result = await api("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ownerName, folderMode, validityHours, importToken: state.importToken }),
    });
    location.href = `${result.sharePath}?created=1`;
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

async function copyAddressValue(input, successMessage) {
  const address = input.value;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(address);
  } else {
    input.focus();
    input.select();
    document.execCommand("copy");
  }
  toast(successMessage);
}

async function copyShareAddress() {
  try {
    await copyAddressValue($("#share-address"), "本组唯一地址已复制，请创建人妥善保存");
  } catch {
    $("#share-address").focus();
    $("#share-address").select();
    toast("请长按已选中的地址进行复制");
  }
}

function showCreatedLinkReminder() {
  if (new URLSearchParams(location.search).get("created") !== "1") return;
  $("#created-share-address").value = state.task.shareUrl;
  history.replaceState({}, "", location.pathname);
  openLayer("created-link-layer");
}

async function copyCreatedAddress() {
  const button = $("#copy-created-address");
  try {
    await copyAddressValue($("#created-share-address"), "地址已复制，请粘贴到安全的位置保存");
    button.textContent = "已复制 ✓";
  } catch {
    $("#created-share-address").focus();
    $("#created-share-address").select();
    toast("请长按已选中的地址进行复制");
  }
}

function askPhotoExport() {
  $("#export-confirm-summary").textContent =
    `“${state.task.name}”目前有 ${state.task.recordCount} 条记录、${state.task.photoCount} 张照片。确认后将按当前内容生成新的 ZIP。`;
  openLayer("export-confirm-layer");
}

async function startPhotoExport() {
  closeLayer("export-confirm-layer");
  const button = $("#confirm-export");
  button.disabled = true;
  try {
    const result = await api(groupApi("/export-photos"), { method: "POST" });
    state.exportJob = { ...result, id: result.id || result.jobId };
    renderExportStatus();
    renderExportModal();
    openLayer("export-layer");
    scheduleExportPoll(true);
  } catch (error) {
    toast(error.message);
    closeLayer("export-layer");
  } finally { button.disabled = false; }
}

function renderExportModal() {
  const job = state.exportJob;
  if (!job) return;
  const active = ["queued", "working"].includes(job.status);
  $("#export-bar").style.width = `${job.progress || 0}%`;
  $("#export-percent").textContent = `${job.progress || 0}%`;
  $("#export-stage").textContent = job.status === "error" ? (job.error || "打包失败") : (job.stage || "正在准备…");
  $("#download-zip").hidden = job.status !== "ready";
  $("#rebuild-zip").hidden = active;
  $("#close-export").textContent = active ? "后台继续" : "关闭";
  if (job.status === "ready") {
    $("#export-title").textContent = "照片包已准备好";
    $("#download-zip").href = job.downloadUrl;
  } else if (job.status === "error") {
    $("#export-title").textContent = "照片包生成失败";
  } else {
    $("#export-title").textContent = "正在准备下载";
  }
}

function openExportStatus() {
  if (!state.exportJob) return askPhotoExport();
  renderExportModal();
  openLayer("export-layer");
}

function scheduleExportPoll(immediate = false) {
  clearTimeout(state.exportPollTimer);
  const job = state.exportJob;
  if (!job || !["queued", "working"].includes(job.status)) return;
  state.exportPollTimer = setTimeout(async () => {
    try {
      state.exportJob = await api(groupApi(`/jobs/${enc(job.id)}`));
      renderExportStatus();
      renderExportModal();
      scheduleExportPoll();
    } catch (error) {
      toast(error.message);
    }
  }, immediate ? 0 : 800);
}

async function clearTask() {
  if ($("#clear-confirmation").value !== "OK") return;
  const button = $("#confirm-clear");
  button.disabled = true;
  try {
    await api(groupApi(), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "OK" }),
    });
    location.href = "/";
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

$("#search").addEventListener("input", (event) => { state.query = event.target.value; render(); });
$("#year").addEventListener("change", (event) => { state.year = event.target.value; render(); });
$("#sort-order").addEventListener("click", () => {
  state.sortOrder = state.sortOrder === "desc" ? "asc" : "desc";
  $("#sort-order").textContent = state.sortOrder === "desc" ? "↓ 倒序" : "↑ 正序";
  render();
});
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  state.filter = button.dataset.filter;
  $("#list-title").textContent = { all: "全部凭证", pending: "待上传凭证", done: "已上传凭证" }[state.filter];
  render();
}));
$("#close-sheet").addEventListener("click", closeVoucher);
$("#backdrop").addEventListener("click", closeVoucher);
$("#close-preview").addEventListener("click", closePreview);
$("#rotate-left").addEventListener("click", () => {
  if (state.previewImage) {
    state.previewImage.rotation -= 90;
    updateRotationPreview();
  }
});
$("#save-rotation").addEventListener("click", saveRotation);
$("#cancel-delete").addEventListener("click", () => resolveDeleteConfirmation(false));
$("#confirm-delete").addEventListener("click", () => resolveDeleteConfirmation(true));
$("#camera-input").addEventListener("change", (event) => uploadPhotos(event.target.files, event.target.closest("label")));
$("#gallery-input").addEventListener("change", (event) => uploadPhotos(event.target.files, event.target.closest("label")));
$("#landing-create").addEventListener("click", openImport);
$("#import-file").addEventListener("change", (event) => {
  $("#import-file-label").textContent = event.target.files[0]?.name || "选择填写好的 Excel";
  state.importToken = null;
});
$("#preview-import").addEventListener("click", previewImport);
$("#create-task").addEventListener("click", createTask);
$("#copy-address").addEventListener("click", copyShareAddress);
$("#copy-created-address").addEventListener("click", copyCreatedAddress);
$("#created-link-done").addEventListener("click", () => closeLayer("created-link-layer"));
$("#export-records").addEventListener("click", () => { location.href = groupApi("/export-records"); });
$("#export-photos").addEventListener("click", () => state.exportJob ? openExportStatus() : askPhotoExport());
$("#confirm-export").addEventListener("click", startPhotoExport);
$("#open-export-status").addEventListener("click", openExportStatus);
$("#rebuild-zip").addEventListener("click", () => {
  closeLayer("export-layer");
  askPhotoExport();
});
$("#open-clear").addEventListener("click", () => {
  $("#clear-summary").textContent =
    `将永久删除“${state.task.name}”的 ${state.task.recordCount} 条记录和 ${state.task.photoCount} 张照片，固定地址也会立即失效。`;
  $("#clear-confirmation").value = "";
  $("#confirm-clear").disabled = true;
  openLayer("clear-layer");
});
$("#clear-confirmation").addEventListener("input", (event) => {
  $("#confirm-clear").disabled = event.target.value !== "OK";
});
$("#confirm-clear").addEventListener("click", clearTask);
$("#close-export").addEventListener("click", () => closeLayer("export-layer"));
document.querySelectorAll(".close-modal").forEach((button) =>
  button.addEventListener("click", () => closeLayer(button.dataset.close)));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#confirm-layer").hidden) return resolveDeleteConfirmation(false);
  if (!$("#preview").hidden) return closePreview();
  if (state.selected) return closeVoucher();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.task) {
    syncGroupChanges();
    scheduleGroupSync();
  }
});

if (state.accessToken) {
  $("#admin-entry").hidden = true;
  loadGroup().catch((error) => {
    document.body.classList.add("landing-mode", "landing-mode-error");
    $("#landing").hidden = false;
    $("#group-main").hidden = true;
    clearInterval(state.expiryTimer);
    clearTimeout(state.syncTimer);
    $("#expiry-countdown").hidden = true;
    $(".landing-headline").innerHTML = "这个拍摄组<br />无法打开";
    $(".landing-summary").textContent = error.message;
    $("#landing-create").textContent = "返回并建立新组";
    $("#landing-create").onclick = () => { location.href = "/"; };
    $("#capacity-note").textContent = "请检查分享地址是否完整；该组也可能已到期自动删除。";
  });
} else {
  loadLanding();
}
