// ── test-inline.js(0.5.1 改離線 stub fetch 版)───────────────────────────
// A1 驗證:inlinePrintAssets() 對合成的列印 HTML 片段(零真實資料)跑資產內嵌。
// 0.5.0 以前這支測試打遠通真站台(活 session 沙盒),現在改用
// globalThis.fetch stub 攔截 lib/fetc-client.js fetchAssetBuffer() 發出的請求
// ——不打任何網路,CI/斷網環境皆可跑。斷言沿用原五條:無 /Content 殘留(href/src)、
// 含 <style>(CSS 內嵌後標籤)、含 data:image(logo 等背景圖內嵌)、
// <script src="/Content..."> 已移除。
'use strict';

const assert = require('assert');
const { CookieJar, inlinePrintAssets } = require('./lib/fetc-client');

// 合成列印 HTML 片段(零真實資料):<link> 對應站內 CSS(CSS 內含 url(...) 背景圖,
// 比照遠通 logo 實測結構 .logo{background-image:url(../images/logo.png)})、<img>
// 對應站內圖片、<script src> 應被整段移除(純列印用途不需要互動 JS)。
const SAMPLE_HTML = `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/Content/site.css">
<script src="/Content/js/jq.js"></script>
</head>
<body>
<div id="printDetail">
  <img src="/Content/img/x.png" alt="logo">
  <table id="tblFeeList"><tbody>
    <tr class="detail-row"><td>04:01:47</td><td>五股-高公局</td><td>1.4</td><td>1.6元</td></tr>
  </tbody></table>
</div>
</body>
</html>`;

// 1x1 透明 PNG(純測試佔位位元組,不含任何真實素材)
const STUB_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000155a2d69f0000000049454e44ae426082',
  'hex'
);
const STUB_CSS = '.logo{background-image:url(../images/logo.png)}';

// stub:攔截 fetchAssetBuffer() 對 site.css / x.png / logo.png(CSS 內 url(...) 解析出的
// 相對圖片路徑)的請求,回合成內容;其餘 URL 視為測試沒設想到的情況,直接丟例外。
async function stubFetch(url) {
  const u = String(url);
  if (u.endsWith('/Content/site.css')) {
    return new Response(STUB_CSS, { status: 200, headers: { 'content-type': 'text/css' } });
  }
  if (u.endsWith('/images/logo.png') || u.endsWith('/Content/img/x.png')) {
    return new Response(STUB_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  throw new Error(`stubFetch: 未預期的 URL(測試樁只認得 site.css/x.png/logo.png):${u}`);
}

async function main() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;

  let inlined;
  try {
    const jar = new CookieJar();
    inlined = await inlinePrintAssets(SAMPLE_HTML, jar);
  } finally {
    globalThis.fetch = realFetch; // 不汙染其他測試/呼叫端
  }

  assert.ok(!/href="\/Content/i.test(inlined), '不應殘留 href="/Content(CSS 未內嵌乾淨)');
  assert.ok(!/src="\/Content/i.test(inlined), '不應殘留 src="/Content(img/script 未內嵌乾淨)');
  assert.ok(/<style>/i.test(inlined), '應含 <style>(CSS 內嵌後的標籤)');
  assert.ok(/data:image/i.test(inlined), '應含至少一個 data:image(logo 等背景圖內嵌)');
  assert.ok(!/<script[^>]*\ssrc="\/Content/i.test(inlined), '不應殘留 <script src="/Content(應已移除)');

  console.log('[test-inline] PASS(離線 stub fetch,零網路)');
}

main().catch((e) => {
  console.error('[test-inline] FAIL', e);
  process.exit(1);
});
