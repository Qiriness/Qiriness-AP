const MOJIBAKE_MARKER_PATTERN = /[\u00C2\u00C3\u00C5\u00E2]/;
const WINDOWS_1252_REVERSE_BYTES = new Map([
  [0x20AC, 0x80],
  [0x201A, 0x82],
  [0x0192, 0x83],
  [0x201E, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02C6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8A],
  [0x2039, 0x8B],
  [0x0152, 0x8C],
  [0x017D, 0x8E],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201C, 0x93],
  [0x201D, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02DC, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9A],
  [0x203A, 0x9B],
  [0x0153, 0x9C],
  [0x017E, 0x9E],
  [0x0178, 0x9F]
]);

const COMMON_MOJIBAKE_REPLACEMENTS = [
  ['\u00C2\u00A0', ' '],
  ['\u00C3\u00A0', '\u00E0'],
  ['\u00C3\u00A2', '\u00E2'],
  ['\u00C3\u00A7', '\u00E7'],
  ['\u00C3\u00A8', '\u00E8'],
  ['\u00C3\u00A9', '\u00E9'],
  ['\u00C3\u00AA', '\u00EA'],
  ['\u00C3\u00AB', '\u00EB'],
  ['\u00C3\u00AE', '\u00EE'],
  ['\u00C3\u00AF', '\u00EF'],
  ['\u00C3\u00B4', '\u00F4'],
  ['\u00C3\u00B6', '\u00F6'],
  ['\u00C3\u00B9', '\u00F9'],
  ['\u00C3\u00BB', '\u00FB'],
  ['\u00C3\u00BC', '\u00FC'],
  ['\u00C3\u0080', '\u00C0'],
  ['\u00C3\u0088', '\u00C8'],
  ['\u00C3\u0089', '\u00C9'],
  ['\u00C5\u201C', '\u0153'],
  ['\u00C5\u2019', '\u0152'],
  ['\u00E2\u20AC\u2122', '\u2019'],
  ['\u00E2\u20AC\u0099', '\u2019'],
  ['\u00E2\u20AC\u0153', '\u201C'],
  ['\u00E2\u20AC\u009C', '\u201C'],
  ['\u00E2\u20AC\u009D', '\u201D'],
  ['\u00E2\u20AC\u201D', '\u201D'],
  ['\u00E2\u20AC\u201C', '\u2013'],
  ['\u00E2\u20AC\u0093', '\u2013'],
  ['\u00E2\u20AC\u0094', '\u2014'],
  ['\u00E2\u0080\u00A2', '\u2022']
];

export function cleanJsonValue(value) {
  if (typeof value === 'string') {
    return cleanTextValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(cleanJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanJsonValue(entry)])
    );
  }
  return value;
}

export function cleanTextValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.replace(/\u00A0/g, ' ').normalize('NFC');
  if (!MOJIBAKE_MARKER_PATTERN.test(normalized)) {
    return normalized;
  }

  return repairUtf8DecodedAsWindows1252(normalized).replace(/\u00A0/g, ' ').normalize('NFC');
}

function repairUtf8DecodedAsWindows1252(value) {
  const bytes = [];

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xFF) {
      bytes.push(codePoint);
      continue;
    }

    const byte = WINDOWS_1252_REVERSE_BYTES.get(codePoint);
    if (byte === undefined) {
      return repairCommonMojibakeSequences(value);
    }
    bytes.push(byte);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return repairCommonMojibakeSequences(value);
  }
}

function repairCommonMojibakeSequences(value) {
  let repaired = value;
  for (const [broken, fixed] of COMMON_MOJIBAKE_REPLACEMENTS) {
    repaired = repaired.replaceAll(broken, fixed);
  }
  return repaired;
}
