const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
let selectedGroup = null;
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
function dateTime(value) {
  return value ? beijingDateTime.format(new Date(value)) : "—";
}
function exportStatus(job) {
  if (!job) return "尚未打包";
  if (job.status === "ready") return "照片包可下载";
  if (job.status === "error") return "打包失败";
  return `${job.stage || "后台处理中"} ${job.progress || 0}%`;
}
function folderModeLabel(mode) {
  return mode === "flat" ? "日期-凭证号（单层）" : "年份 / 月份 / 凭证号";
}
function expiryLabel(expiresAt) {
  if (!expiresAt) return "长期有效";
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) return "正在自动删除";
  const totalMinutes = Math.ceil(remaining / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const left = days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
  return `剩余 ${left} · ${dateTime(expiresAt)}`;
}
function showLogin(message = "") {
  $("#admin-main").hidden = true;
  $("#admin-login-layer").hidden = false;
  $("#admin-login-error").textContent = message;
  $("#admin-login-error").hidden = !message;
  $("#admin-password").focus();
}
function showAdmin() {
  $("#admin-login-layer").hidden = true;
  $("#admin-main").hidden = false;
}
async function copyAddress(address) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(address);
    else {
      const input = document.createElement("input");
      input.value = address;
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    toast("组地址已复制");
  } catch { toast("复制失败，请打开组后手动复制"); }
}
function render(data) {
  const used = data.groups.length;
  $("#capacity-number").textContent = `${used}/${data.maxTasks}`;
  $("#max-tasks").value = data.maxTasks;
  $("#capacity-title").textContent = data.availableSlots ? `还可以建立 ${data.availableSlots} 个组` : "当前已达到设定组数";
  $("#capacity-detail").textContent = used ? "降低上限不会删除现有组，但在清理到上限以内前不能新建。" : "当前没有正在使用的组。";
  $("#group-total").textContent = `${used} 组`;
  $("#admin-empty").hidden = used > 0;
  $("#admin-group-list").innerHTML = [...data.groups]
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .map((group) => `
      <article class="admin-group" data-id="${escapeHtml(group.id)}">
        <div><h3>${escapeHtml(group.name)}</h3><span class="owner">使用人：${escapeHtml(group.ownerName)}</span></div>
        <div class="admin-meta">
          <span>最后活动<strong>${escapeHtml(dateTime(group.lastActivityAt))}</strong></span>
          <span>建立时间<strong>${escapeHtml(dateTime(group.createdAt))}</strong></span>
          <span>归档进度<strong>${group.completedCount}/${group.recordCount} 条 · ${group.photoCount} 张</strong></span>
          <span>文件夹规则<strong>${escapeHtml(folderModeLabel(group.folderMode))}</strong></span>
          <span>照片导出<strong>${escapeHtml(exportStatus(group.exportJob))}</strong></span>
          <span class="admin-expiry-meta">有效期<strong>${escapeHtml(expiryLabel(group.expiresAt))}</strong></span>
        </div>
        <div class="admin-actions">
          <button class="copy-group" type="button">复制地址</button>
          <a href="${escapeHtml(group.shareUrl)}" target="_blank" rel="noopener">打开组</a>
          <div class="admin-expiry-control">
            <select aria-label="修改${escapeHtml(group.name)}的有效期">
              <option value="24">从现在起 24 小时</option>
              <option value="48">从现在起 48 小时</option>
              <option value="168">从现在起 7 天</option>
              <option value="720">从现在起 30 天</option>
              <option value="permanent">长期有效</option>
            </select>
            <button class="update-expiry" type="button">更新有效期</button>
          </div>
          <button class="delete-group" type="button">删除组</button>
        </div>
      </article>`).join("");
  document.querySelectorAll(".admin-group").forEach((row) => {
    const group = data.groups.find((item) => item.id === row.dataset.id);
    row.querySelector(".copy-group").addEventListener("click", () => copyAddress(group.shareUrl));
    row.querySelector(".update-expiry").addEventListener("click", () => updateExpiry(group, row));
    row.querySelector(".delete-group").addEventListener("click", () => openDelete(group));
  });
}
async function loadGroups() {
  try {
    const data = await api("/api/admin/groups");
    $("#admin-error").hidden = true;
    showAdmin();
    render(data);
  } catch (error) {
    if (error.status === 401) return showLogin();
    $("#admin-error").textContent = error.message;
    $("#admin-error").hidden = false;
  }
}
async function login(event) {
  event.preventDefault();
  const button = $("#admin-login-button");
  button.disabled = true;
  button.textContent = "验证中…";
  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#admin-password").value }),
    });
    $("#admin-password").value = "";
    await loadGroups();
  } catch (error) {
    showLogin(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "进入管理";
  }
}
async function logout() {
  await api("/api/admin/logout", { method: "POST" }).catch(() => {});
  showLogin();
}
async function saveCapacity(event) {
  event.preventDefault();
  const button = $("#capacity-form button");
  button.disabled = true;
  try {
    await api("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTasks: Number($("#max-tasks").value) }),
    });
    toast("允许组数已保存");
    await loadGroups();
  } catch (error) {
    if (error.status === 401) return showLogin("登录已过期，请重新输入密码。");
    toast(error.message);
  } finally { button.disabled = false; }
}
async function updateExpiry(group, row) {
  const button = row.querySelector(".update-expiry");
  const value = row.querySelector(".admin-expiry-control select").value;
  button.disabled = true;
  try {
    await api(`/api/admin/groups/${encodeURIComponent(group.id)}/expiry`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value === "permanent" ? { mode: "permanent" } : { hours: Number(value) }),
    });
    toast(value === "permanent" ? "已设为长期有效" : "有效期已从当前时间重新计算");
    await loadGroups();
  } catch (error) {
    if (error.status === 401) return showLogin("登录已过期，请重新输入密码。");
    toast(error.message);
    button.disabled = false;
  }
}
function openDelete(group) {
  selectedGroup = group;
  $("#admin-delete-summary").textContent =
    `将删除“${group.name}”（使用人：${group.ownerName}）的 ${group.recordCount} 条记录、${group.photoCount} 张照片和分享地址。删除后无法恢复。`;
  $("#admin-delete-confirmation").value = "";
  $("#confirm-admin-delete").disabled = true;
  $("#admin-delete-layer").hidden = false;
}
function closeDelete() {
  selectedGroup = null;
  $("#admin-delete-layer").hidden = true;
}
async function deleteGroup() {
  if (!selectedGroup || $("#admin-delete-confirmation").value !== "DELETE") return;
  const button = $("#confirm-admin-delete");
  button.disabled = true;
  try {
    await api(`/api/admin/groups/${encodeURIComponent(selectedGroup.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    closeDelete();
    toast("拍摄组已删除");
    await loadGroups();
  } catch (error) {
    if (error.status === 401) return showLogin("登录已过期，请重新输入密码。");
    toast(error.message);
    button.disabled = false;
  }
}
$("#admin-login-form").addEventListener("submit", login);
$("#admin-logout").addEventListener("click", logout);
$("#capacity-form").addEventListener("submit", saveCapacity);
$("#admin-delete-confirmation").addEventListener("input", (event) => {
  $("#confirm-admin-delete").disabled = event.target.value !== "DELETE";
});
$("#cancel-admin-delete").addEventListener("click", closeDelete);
$("#confirm-admin-delete").addEventListener("click", deleteGroup);
loadGroups();
