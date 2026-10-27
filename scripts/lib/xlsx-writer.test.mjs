import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';

import { columnName, writeXlsx } from './xlsx-writer.mjs';

/** The files of a zip, read through its central directory: { path: text }. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const path = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    files[path] = inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('column names run A..Z, then AA', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('a workbook: the parts Excel needs, a bold header, text and numbers, escaped', () => {
  const files = unzip(
    writeXlsx({
      sheetName: 'Stock: alert/1',
      columns: [{ header: 'Produit', width: 40 }, { header: 'Stock' }],
      rows: [
        ['Crème « Éclat » & <Nuit>', 3],
        ['Sans couverture', null]
      ]
    })
  );
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml'
  ]);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Produit<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Crème « Éclat » &amp; &lt;Nuit&gt;<\/t><\/is><\/c><c r="B2"><v>3<\/v><\/c>/);
  assert.match(sheet, /<row r="3"><c r="A3"[^>]*>.*Sans couverture.*<\/c><\/row>/);
  assert.match(files['xl/workbook.xml'], /<sheet name="Stock  alert 1"/);
});
