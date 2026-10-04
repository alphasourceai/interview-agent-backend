'use strict';

const JSZip = require('jszip');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function xml(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function columnName(index) {
  let remaining = index + 1;
  let name = '';
  while (remaining > 0) {
    remaining -= 1;
    name = String.fromCharCode(65 + remaining % 26) + name;
    remaining = Math.floor(remaining / 26);
  }
  return name;
}

function excelDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error('invalid_excel_date');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('invalid_excel_date');
  return Math.round((date.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

function cell(value, col, row) {
  const reference = `${columnName(col)}${row}`;
  if (value && typeof value === 'object' && value.kind === 'date') {
    return `<c r="${reference}" s="4"><v>${excelDate(value.value)}</v></c>`;
  }
  if (value && typeof value === 'object' && value.kind === 'money') {
    if (!Number.isSafeInteger(value.cents)) throw new Error('invalid_excel_amount');
    return `<c r="${reference}" s="2"><v>${value.cents / 100}</v></c>`;
  }
  if (value && typeof value === 'object' && value.kind === 'count') {
    if (!Number.isSafeInteger(value.value)) throw new Error('invalid_excel_count');
    return `<c r="${reference}" s="3"><v>${value.value}</v></c>`;
  }
  const header = value && typeof value === 'object' && value.kind === 'header';
  const plain = header ? value.value : value;
  if (plain == null || plain === '') return '';
  // Inline strings remain text even when a source name starts with =, +, -, or @.
  return `<c r="${reference}" s="${header ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${xml(plain)}</t></is></c>`;
}

function sheet(rows, widths, headerRow) {
  const longest = Math.max(...rows.map((row) => row.length), 1);
  const rowXml = rows.map((values, index) => `<row r="${index + 1}">${values.map((value, col) => cell(value, col, index + 1)).join('')}</row>`).join('');
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
  const headerEnd = `${columnName(longest - 1)}${Math.max(rows.length, headerRow)}`;
  const filterEnd = `${columnName(longest - 1)}${Math.max(rows.length - 1, headerRow)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}">` +
    `<dimension ref="A1:${headerEnd}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${rowXml}</sheetData>` +
    `<autoFilter ref="A${headerRow}:${filterEnd}"/></worksheet>`;
}

function safeSheetNames(representatives) {
  const used = new Set(['summary']);
  return representatives.map((representative) => {
    const base = String(representative.display_name || representative.email || 'Salesperson')
      .replace(/[\\/*?:\[\]]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Salesperson';
    let name = base.slice(0, 31);
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
      const ending = ` (${suffix})`;
      name = `${base.slice(0, 31 - ending.length)}${ending}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const h = (value) => ({ kind: 'header', value });
const money = (cents) => ({ kind: 'money', cents });
const count = (value) => ({ kind: 'count', value });
const date = (value) => ({ kind: 'date', value });

function summaryRows(report) {
  const rows = [
    ['Sales payroll'],
    [`${report.date_from} to ${report.date_to} (Mountain Time)`],
    ['Reviewed membership payments by funds-received date; refunds and recoveries by effective date.'],
    [],
    ['Salesperson', 'Sales', 'Sales amount', 'Adjustments', 'Net revenue', 'Commission'].map(h),
  ];
  for (const representative of report.representatives) rows.push([
    representative.display_name || representative.email, count(representative.sale_count),
    money(representative.gross_sales_cents), money(representative.adjustment_cents),
    money(representative.net_revenue_cents), money(representative.commission_cents),
  ]);
  rows.push([h('Total'), count(report.totals.sale_count), money(report.totals.gross_sales_cents),
    money(report.totals.adjustment_cents), money(report.totals.net_revenue_cents), money(report.totals.commission_cents)]);
  return rows;
}

function representativeRows(report, representative) {
  const rows = [
    [representative.display_name || representative.email],
    [`${report.date_from} to ${report.date_to} (Mountain Time)`],
    [`${representative.sale_count} distinct client sale${representative.sale_count === 1 ? '' : 's'} with a reviewed payment in this period`],
    [],
    ['Date', 'Client', 'Activity', 'Sales amount', 'Adjustments', 'Net revenue', 'Commission', 'Sale ID', 'Receipt ID'].map(h),
  ];
  for (const event of representative.events) rows.push([
    date(event.date), event.client_name, event.activity, money(event.gross_sales_cents),
    money(event.adjustment_cents), money(event.net_revenue_cents), money(event.commission_cents), event.purchase_intent_id, event.receipt_id,
  ]);
  rows.push([h('Total'), '', '', money(representative.gross_sales_cents), money(representative.adjustment_cents),
    money(representative.net_revenue_cents), money(representative.commission_cents)]);
  return rows;
}

async function buildSalesPayrollWorkbook(report) {
  const names = safeSheetNames(report.representatives);
  const sheets = [{ name: 'Summary', rows: summaryRows(report), widths: [30, 13, 19, 19, 19, 19] },
    ...report.representatives.map((representative, index) => ({
      name: names[index], rows: representativeRows(report, representative), widths: [16, 35, 24, 19, 19, 19, 19, 40, 40],
    }))];
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>${sheets.map((item, index) => `<sheet name="${xml(item.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;[Red](&quot;$&quot;#,##0.00)"/><numFmt numFmtId="165" formatCode="mm/dd/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0A1547"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  sheets.forEach((item, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheet(item.rows, item.widths, 5)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { buildSalesPayrollWorkbook, safeSheetNames, excelDate };
