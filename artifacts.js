// Deterministic document builder used by the Telegram agent.  Keeping this
// outside the LLM means the bot can prove it created a real file before it
// tells the user that a task is finished.
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(process.cwd(), "generated_files");

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanName(name, extension) {
  const base = String(name || "document").replace(/[^a-zA-Z0-9._ -]/g, "_").trim().slice(0, 80) || "document";
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

function countNumberedItems(content) {
  return String(content || "").split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|Q\s*\d+[:.)])/i.test(line)).length;
}

function asHtml(title, content, accent) {
  const source = String(content || "").trim();
  if (/<(?:html|body|h[1-6]|p|table|ul|ol)\b/i.test(source)) return source;
  const lines = source.split(/\r?\n/);
  const body = lines.map((line) => {
    const safe = escapeHtml(line);
    if (/^\s*#{1,3}\s+/.test(line)) return `<h2>${safe.replace(/^\s*#+\s*/, "")}</h2>`;
    if (/^\s*(?:\d+[.)]|[-*•])\s+/.test(line)) return `<p class="item">${safe}</p>`;
    return line.trim() ? `<p>${safe}</p>` : "<div class=\"gap\"></div>";
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  @page { size: A4; margin: 18mm; } body { font-family: Arial, 'Noto Sans Sinhala', sans-serif; color:#172033; line-height:1.55; max-width:820px; margin:auto; padding:36px; }
  h1 { color:${accent}; border-bottom:3px solid ${accent}; padding-bottom:10px; } h2 { color:${accent}; margin-top:24px; } .item { background:#f6f8fc; border-left:4px solid ${accent}; padding:10px 12px; } .gap { height:8px; }
  </style></head><body><h1>${escapeHtml(title || "Document")}</h1>${body}</body></html>`;
}

// A small ZIP writer ("store" compression) lets us produce a standards-valid
// .docx without relying on a native binary or a package being installed.
function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(input)) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const parts = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content), nameBuf = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBuf.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf); offset += local.length + nameBuf.length + data.length;
  }
  const centralData = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralData, end]);
}
function xmlEscape(s) { return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function docxBuffer(title, content, accent) {
  const paragraphs = [title, ...String(content || "").replace(/<[^>]*>/g, "").split(/\r?\n/)].filter(Boolean).map((line, i) => `<w:p><w:pPr>${i === 0 ? '<w:pStyle w:val="Title"/>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join("");
  return zipStore([
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`],
    ["word/styles.xml", `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:color w:val="${String(accent || "2563EB").replace("#", "")}"/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`],
  ]);
}

function pdfEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function pdfBuffer(title, content) {
  // Core PDF fonts are intentionally used: this produces a portable PDF with
  // no external renderer. For Sinhala-heavy content the .docx/.html choice is
  // preferable because those formats preserve Unicode text.
  const lines = [title, ...String(content || "").replace(/<[^>]*>/g, "").split(/\r?\n/)].flatMap((x) => String(x).match(/.{1,88}(?:\s|$)|\S+/g) || [""]).slice(0, 600);
  const stream = ["BT", "/F1 18 Tf", "72 770 Td", `(${pdfEscape(lines[0] || "Document")}) Tj`, "/F1 10 Tf", "0 -28 Td", ...lines.slice(1).map((line) => `(${pdfEscape(line)}) Tj 0 -15 Td`), "ET"].join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let out = "%PDF-1.4\n", offsets = [0]; objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; }); const xref = Buffer.byteLength(out); out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

function createArtifact({ format, title, content, file_name, accent_color = "#2563EB", expected_item_count } = {}) {
  const type = String(format || "html").toLowerCase();
  if (!['html', 'docx', 'pdf', 'txt'].includes(type)) return { ok: false, error: "Unsupported format. Use html, docx, pdf, or txt." };
  const count = expected_item_count == null ? null : countNumberedItems(content);
  if (expected_item_count != null && count !== Number(expected_item_count)) return { ok: false, error: `Expected exactly ${expected_item_count} numbered items, but found ${count}. Fix the content and try again.`, detected_item_count: count };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true }); const outputPath = path.join(OUTPUT_DIR, `${Date.now()}-${cleanName(file_name || title, type)}`);
  const html = asHtml(title, content, accent_color);
  if (type === "html") fs.writeFileSync(outputPath, html, "utf8");
  else if (type === "docx") fs.writeFileSync(outputPath, docxBuffer(title, content, accent_color));
  else if (type === "pdf") fs.writeFileSync(outputPath, pdfBuffer(title, content));
  else fs.writeFileSync(outputPath, String(content || ""), "utf8");
  const size = fs.statSync(outputPath).size;
  if (!size) return { ok: false, error: "Generated file was empty." };
  return { ok: true, path: outputPath, file_name: path.basename(outputPath), format: type, bytes: size, detected_item_count: count };
}
module.exports = { createArtifact, countNumberedItems, asHtml };
