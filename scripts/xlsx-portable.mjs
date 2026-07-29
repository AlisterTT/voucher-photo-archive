import fs from "node:fs/promises";
import JSZip from "jszip";
import { formatBeijingDateTime } from "./beijing-time.mjs";

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function attribute(source, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] || "";
}

function columnIndex(reference) {
  const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase() || "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function excelDate(value, date1904 = false) {
  if (typeof value === "number" && value > 20000 && value < 80000) {
    return new Date(Math.round((value - (date1904 ? 24107 : 25569)) * 86400000)).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10);
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (!match) return null;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : date;
}

async function readSharedStrings(zip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const xml = await file.async("string");
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((match) =>
    [...match[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((text) => decodeXml(text[1]))
      .join(""));
}

async function firstWorksheetPath(zip) {
  const workbookFile = zip.file("xl/workbook.xml");
  const relationshipsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (workbookFile && relationshipsFile) {
    const workbook = await workbookFile.async("string");
    const relationships = await relationshipsFile.async("string");
    const relationshipId = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
    if (relationshipId) {
      const relationship = [...relationships.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)]
        .find((match) => attribute(match[1], "Id") === relationshipId);
      const target = relationship ? attribute(relationship[1], "Target") : "";
      if (target) {
        const normalized = target.startsWith("/")
          ? target.slice(1)
          : `xl/${target.replace(/^(\.\.\/)+/, "")}`;
        if (zip.file(normalized)) return normalized;
      }
    }
  }
  return Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    .sort()[0];
}

function cellValue(inner, type, sharedStrings) {
  if (type === "inlineStr") {
    return [...inner.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((match) => decodeXml(match[1]))
      .join("");
  }
  const raw = decodeXml(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1] || "");
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "b") return raw === "1";
  if ((!type || type === "n") && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cellMatch[1];
      const reference = attribute(attrs, "r");
      const type = attribute(attrs, "t");
      row[columnIndex(reference)] = cellMatch[2] === undefined ? null : cellValue(cellMatch[2], type, sharedStrings);
    }
    const rowNumber = Number(attribute(rowMatch[1], "r")) || rows.length + 1;
    rows[rowNumber - 1] = row;
  }
  return rows;
}

function recordsFromRows(values, date1904 = false) {
  const aliases = {
    date: ["日期", "日期*"],
    organization: ["财务组织", "财务组织*", "组织", "组织*"],
    voucher: ["凭证号", "凭证号*"],
    amount: ["总金额", "金额"],
  };
  let headerIndex = -1;
  let columns = {};
  for (let rowIndex = 0; rowIndex < Math.min(values.length, 20); rowIndex += 1) {
    const row = (values[rowIndex] || []).map((cell) => String(cell ?? "").trim());
    const found = {};
    for (const [key, names] of Object.entries(aliases)) {
      found[key] = row.findIndex((cell) => names.includes(cell));
    }
    if (found.date >= 0 && found.organization >= 0 && found.voucher >= 0) {
      headerIndex = rowIndex;
      columns = found;
      break;
    }
  }
  if (headerIndex < 0) return { records: [], errors: ["未找到“日期、财务组织、凭证号”表头。"] };

  const records = [];
  const errors = [];
  const seen = new Set();
  for (let rowIndex = headerIndex + 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const rawDate = row[columns.date];
    const organization = String(row[columns.organization] ?? "").trim();
    const voucher = String(row[columns.voucher] ?? "").trim();
    const rawAmount = columns.amount >= 0 ? row[columns.amount] : null;
    if ([rawDate, organization, voucher, rawAmount].every((value) =>
      value === null || value === undefined || String(value).trim() === "")) continue;
    const date = excelDate(rawDate, date1904);
    const rowNumber = rowIndex + 1;
    if (!date) errors.push(`第 ${rowNumber} 行：日期格式无效，请使用 yyyy-mm-dd。`);
    if (!organization) errors.push(`第 ${rowNumber} 行：财务组织不能为空。`);
    if (!voucher) errors.push(`第 ${rowNumber} 行：凭证号不能为空。`);
    let amount = null;
    if (rawAmount !== null && rawAmount !== undefined && String(rawAmount).trim() !== "") {
      amount = Number(rawAmount);
      if (!Number.isFinite(amount)) {
        errors.push(`第 ${rowNumber} 行：总金额必须是数字或留空。`);
        amount = null;
      }
    }
    if (!date || !organization || !voucher) continue;
    const key = `${date}\u0000${organization}\u0000${voucher}`;
    if (seen.has(key)) {
      errors.push(`第 ${rowNumber} 行：日期、财务组织、凭证号与前面记录重复。`);
      continue;
    }
    seen.add(key);
    records.push({ date, organization, voucher, amount });
  }
  if (!records.length && !errors.length) errors.push("清单中没有可导入的记录。");
  return { records, errors };
}

export async function parseXlsx(source) {
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  const worksheetPath = await firstWorksheetPath(zip);
  if (!worksheetPath) throw new Error("XLSX 中没有可读取的工作表。");
  const [worksheetXml, sharedStrings, workbookXml] = await Promise.all([
    zip.file(worksheetPath).async("string"),
    readSharedStrings(zip),
    zip.file("xl/workbook.xml")?.async("string") || "",
  ]);
  const date1904 = /\bdate1904="(?:1|true)"/i.test(workbookXml);
  return recordsFromRows(parseSheetRows(worksheetXml, sharedStrings), date1904);
}

function inlineCell(reference, value, style = 0) {
  if (value === null || value === undefined || value === "") return `<c r="${reference}"${style ? ` s="${style}"` : ""}/>`;
  return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function numberCell(reference, value, style = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return `<c r="${reference}"${style ? ` s="${style}"` : ""}/>`;
  return `<c r="${reference}"${style ? ` s="${style}"` : ""}><v>${Number(value)}</v></c>`;
}

function rowXml(index, cells, height) {
  return `<row r="${index}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells.join("")}</row>`;
}

function worksheetXml(payload) {
  const records = payload.records || [];
  const attachmentCount = records.reduce((sum, record) => sum + Number(record.attachmentCount || 0), 0);
  const rows = [
    rowXml(1, [inlineCell("A1", payload.taskName || "凭证拍摄记录", 1)], 32),
    rowXml(2, [inlineCell("A2", `导出时间（北京时间）：${formatBeijingDateTime()}　记录：${records.length} 条　附件：${attachmentCount} 个`, 2)], 24),
    rowXml(3, []),
    rowXml(4, ["序号", "日期", "财务组织", "凭证号", "总金额", "附件数量", "状态"]
      .map((value, index) => inlineCell(`${String.fromCharCode(65 + index)}4`, value, 3)), 28),
    ...records.map((record, index) => {
      const row = index + 5;
      return rowXml(row, [
        numberCell(`A${row}`, index + 1, 6),
        inlineCell(`B${row}`, record.date, 4),
        inlineCell(`C${row}`, record.organization),
        inlineCell(`D${row}`, record.voucher),
        numberCell(`E${row}`, record.amount, 5),
        numberCell(`F${row}`, record.attachmentCount, 6),
        inlineCell(`G${row}`, record.attachmentCount > 0 ? "已上传" : "未上传"),
      ]);
    }),
  ];
  const lastRow = Math.max(4, records.length + 4);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:G${lastRow}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols><col min="1" max="1" width="9" customWidth="1"/><col min="2" max="2" width="15" customWidth="1"/><col min="3" max="3" width="24" customWidth="1"/><col min="4" max="4" width="18" customWidth="1"/><col min="5" max="5" width="14" customWidth="1"/><col min="6" max="7" width="12" customWidth="1"/></cols>
  <sheetData>${rows.join("")}</sheetData>
  <mergeCells count="2"><mergeCell ref="A1:G1"/><mergeCell ref="A2:G2"/></mergeCells>
</worksheet>`;
}

export async function writeRecordsXlsx(payload, target) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.folder("xl").file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="本次记录" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.folder("xl").folder("_rels").file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.folder("xl").file("styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
  <fonts count="3"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="18"/><color rgb="FF1E2523"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1ECE3"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E2523"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);
  zip.folder("xl").folder("worksheets").file("sheet1.xml", worksheetXml(payload));
  await fs.writeFile(target, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  }));
}
