// ── test-inline.js ───────────────────────────────────────────────────────
// A1 驗證:對 scratchpad 裡真實抓下的遠通列印 HTML(fetc-print-resp.txt)跑
// inlinePrintAssets(),CSS/img 資產走活 session 沙盒直抓(沙盒可達 www.fetc.net.tw,
// 見 Round E context)。斷言結果全自包含:無 href="/Content、無 src="/Content、
// 含 <style>、含 data:image。印出內嵌前後大小供人工核對(內嵌後應明顯變大,
// 因 base64 圖片/CSS 全部塞進單一 HTML)。
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { CookieJar, inlinePrintAssets } = require('./lib/fetc-client');

const SAMPLE_PATH = path.join(
  '/private/tmp/claude-501/-Users-liujiahao-Documents-Gafferland-web/6bae19a4-5dd4-409f-a180-1c0b356f4ba8/scratchpad',
  'fetc-print-resp.txt'
);

async function main() {
  const rawHtml = fs.readFileSync(SAMPLE_PATH, 'utf8');
  const beforeSize = Buffer.byteLength(rawHtml, 'utf8');

  // 這份樣本檔已不含真實 session cookie(純靜態資產 css/js/logo 圖片本身不需要
  // 登入態即可抓,GET /Content/* 是公開靜態檔案)——空 jar 即可驗證內嵌邏輯本身;
  // 若遠通日後把 /Content 也鎖進登入態,activity session 沙盒重跑時可傳真 jar。
  const jar = new CookieJar();

  const inlined = await inlinePrintAssets(rawHtml, jar);
  const afterSize = Buffer.byteLength(inlined, 'utf8');

  assert.ok(!/href="\/Content/i.test(inlined), '不應殘留 href="/Content(CSS 未內嵌乾淨)');
  assert.ok(!/src="\/Content/i.test(inlined), '不應殘留 src="/Content(img/script 未內嵌乾淨)');
  assert.ok(/<style>/i.test(inlined), '應含 <style>(CSS 內嵌後的標籤)');
  assert.ok(/data:image/i.test(inlined), '應含至少一個 data:image(logo 等背景圖內嵌)');
  assert.ok(!/<script[^>]*\ssrc="\/Content/i.test(inlined), '不應殘留 <script src="/Content(應已移除)');

  console.log('[test-inline] PASS');
  console.log(`[test-inline] before: ${beforeSize} bytes`);
  console.log(`[test-inline] after : ${afterSize} bytes (x${(afterSize / beforeSize).toFixed(1)})`);
}

main().catch((e) => {
  console.error('[test-inline] FAIL', e);
  process.exit(1);
});
