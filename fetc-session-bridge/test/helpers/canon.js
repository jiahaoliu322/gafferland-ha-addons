'use strict';
// golden 用的無損編碼:JSON 會把 NaN 變 null、把 undefined 欄位整個丟掉,deepStrictEqual 卻分得出來。
// encode 先把這些值換成標記物件,讓 golden(JSON 檔)比對與當年 relay parity 一樣嚴格。
const crypto = require('crypto');

function encode(v) {
  if (v === undefined) return { $undef: true };
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Object.is(v, -0)) return { $num: Object.is(v, -0) ? '-0' : String(v) };
    return v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(encode);
  if (ArrayBuffer.isView(v)) return { $bytes: Array.from(v) };
  const out = {};
  for (const k of Object.keys(v)) out[k] = encode(v[k]);
  return out;
}

// 鍵排序後再序列化(deepStrictEqual 不看鍵順序,雜湊也不該看)
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// 大輸出(上限案 500／100／5000 列)不整份進 golden:長度＋編碼後鍵排序 JSON 的 sha256
function digest(v) {
  return {
    length: Array.isArray(v) ? v.length : v && Array.isArray(v.rows) ? v.rows.length : null,
    sha256: crypto.createHash('sha256').update(stable(encode(v))).digest('hex'),
  };
}

module.exports = { encode, digest };
