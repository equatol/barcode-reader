// バーコード読み取りのテスト
//   使い方: node test/decode.test.js
// ブラウザを使わずに、アプリ本体（script.js）の関数をそのまま呼び出して確認します。

const fs = require('fs');
const path = require('path');
const ZXing = require('../lib/zxing-0.21.3.min.js');

const { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource,
        DecodeHintType, BarcodeFormat } = ZXing;

const APP_DIR = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const js = fs.readFileSync(path.join(APP_DIR, 'script.js'), 'utf8');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(APP_DIR, 'style.css'), 'utf8');

// --- かんたんなテスト用の道具 ---
let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}\n      期待: ${expected}\n      実際: ${actual}`);
    failed++;
  }
}

// --- アプリ本体から読み取り部分を取り出す ---
// script.js は画面（DOM）を操作するのでそのままでは読み込めません。
// 解析に関わる部分だけを取り出して、本物のコードを動かします。
function extract(pattern, label) {
  const matched = js.match(pattern);
  if (!matched) throw new Error(`${label} が script.js に見つかりません`);
  return matched[0];
}

function loadDecoder() {
  const parts = [
    extract(/const FORMATS = \[[\s\S]*?\n\];/, 'FORMATS'),
    extract(/function createHints\(\)[\s\S]*?\n}\n/, 'createHints'),
    extract(/const coreReader = new MultiFormatReader\(\);\ncoreReader\.setHints\(createHints\(\)\);/, 'coreReader'),
    extract(/function toLuminance[\s\S]*?\n}\n/, 'toLuminance'),
    extract(/function brightnessRange[\s\S]*?\n}\n/, 'brightnessRange'),
    extract(/function isHarmlessDecodeError[\s\S]*?\n}\n/, 'isHarmlessDecodeError'),
    extract(/function rotate90[\s\S]*?\n}\n/, 'rotate90'),
    extract(/function decodeLuminance[\s\S]*?\n}\n/, 'decodeLuminance'),
    extract(/function decodeImageData[\s\S]*?\n}\n/, 'decodeImageData'),
  ];
  const body = 'let lastBrightness;\n' + parts.join('\n')
    + '\nreturn { toLuminance, brightnessRange, rotate90, decodeImageData,'
    + ' createHints, getBrightness: () => lastBrightness };';
  const factory = new Function(
    'ZXing', 'MultiFormatReader', 'RGBLuminanceSource', 'BinaryBitmap',
    'HybridBinarizer', 'DecodeHintType', 'BarcodeFormat', body);
  return factory(ZXing, MultiFormatReader, RGBLuminanceSource, BinaryBitmap,
                 HybridBinarizer, DecodeHintType, BarcodeFormat);
}

const app = loadDecoder();

// テスト画像（白黒データ）を、カメラから取り込んだのと同じ形式（RGBA）に変換する
function loadFixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
  const gray = fs.readFileSync(path.join(FIXTURES, `${name}.bin`));
  const rgba = new Uint8ClampedArray(meta.width * meta.height * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    rgba[j] = rgba[j + 1] = rgba[j + 2] = gray[i];
    rgba[j + 3] = 255;
  }
  return { meta, rgba };
}

function decodeFixture(name) {
  const { meta, rgba } = loadFixture(name);
  try {
    const result = app.decodeImageData(rgba, meta.width, meta.height);
    return { meta, text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] };
  } catch (err) {
    return { meta, text: null, format: null }; // 読み取れなかった
  }
}

// ========== ここからテスト ==========

console.log('■ 色から明るさへの変換');
check('白は明るい', app.toLuminance(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1)[0], 255);
check('黒は暗い', app.toLuminance(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1)[0], 0);
// 人の目は緑を明るく感じるので、同じ濃さでも赤は暗めの値になる
check('赤は中くらい', app.toLuminance(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1)[0], 76);

console.log('■ 明るさの範囲の測定（真っ黒な映像を見つけるため）');
{
  const data = new Uint8ClampedArray(1000).fill(100);
  data[0] = 5;
  data[37] = 250;
  const range = app.brightnessRange(data);
  check('一番暗い値', range.min, 5);
  check('一番明るい値', range.max, 250);
}

console.log('■ 画像からの読み取り（アプリと同じ関数）');
for (const name of ['ean13', 'qr']) {
  const r = decodeFixture(name);
  check(`${name}: 読み取った文字`, r.text, r.meta.expected);
  check(`${name}: コードの種類`, r.format, r.meta.format);
}
{
  // 90度回転したバーコードも、回転して再挑戦する処理で読めること
  const r = decodeFixture('ean13_rotated');
  check('回転したバーコードも読める', r.text, r.meta.expected);
}
{
  // 何も写っていない画像では、誤検出せずに「読み取れない」となること
  const r = decodeFixture('blank');
  check('blank: 何も検出しない', r.text, null);
}
{
  // 読み取り中に明るさが記録されていること（真っ黒な映像の判別に使う）
  decodeFixture('ean13');
  check('明るさが記録されている', /^\d+-\d+$/.test(app.getBrightness()), true);
}

console.log('■ iPhoneで動かすために必要な設定');
// playsinline が無いと、iPhoneでカメラ映像が全画面プレーヤーになってしまう
check('video に playsinline がある', /<video[^>]*\splaysinline/.test(html), true);
check('背面カメラを指定している', js.includes('facingMode'), true);
check('マニフェストを読み込んでいる', html.includes('rel="manifest"'), true);
check('apple-touch-icon がある', fs.existsSync(path.join(APP_DIR, 'apple-touch-icon.png')), true);
// hidden属性が確実に効くようにしておく（display指定のあるクラスに打ち消されるのを防ぐ）
check('[hidden] を隠す指定がある', /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css), true);

// 背景色は style.css / index.html / manifest.json の4か所に書かれているので、
// 片方だけ直してホーム画面起動時に色が食い違う事故を防ぐ
{
  const bg = (css.match(/--bg:\s*(#[0-9a-fA-F]{3,8})/) || [])[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'manifest.json'), 'utf8'));
  const themeColor = (html.match(/name="theme-color" content="(#[0-9a-fA-F]{3,8})"/) || [])[1];
  check('theme-color が背景色と一致', themeColor, bg);
  check('manifest の background_color が一致', manifest.background_color, bg);
  check('manifest の theme_color が一致', manifest.theme_color, bg);
}

const scriptSrc = (html.match(/<script src="([^"]*zxing[^"]*)"/) || [])[1] || '';
// ?v=3 のようなキャッシュ対策の印が付くので、それを取り除いてから確認する
const scriptPath = scriptSrc.split('?')[0];
check('ライブラリを自分のサイトから読んでいる', scriptPath, 'lib/zxing-0.21.3.min.js');
check('そのファイルが実在する', fs.existsSync(path.join(APP_DIR, scriptPath)), true);
check('外部CDNを読み込んでいない', /src="https?:/.test(html), false);

// withTimeout（処理が終わらないときに打ち切る仕組み）を script.js から取り出して実際に動かす
(async () => {
  console.log('■ 時間切れの安全装置');
  const withTimeout = new Function(
    'return (' + extract(/function withTimeout[\s\S]*?\n}\n/, 'withTimeout') + ')')();

  check('普通に終わる処理はそのまま返る', await withTimeout(Promise.resolve('ok'), 1000), 'ok');

  let cleanedUp = false;
  const neverEnds = new Promise(() => {}); // わざと終わらない処理
  try {
    await withTimeout(neverEnds, 50, () => { cleanedUp = true; });
    check('終わらない処理は時間切れになる', 'エラーにならなかった', 'TimeoutError');
  } catch (err) {
    check('終わらない処理は時間切れになる', err.name, 'TimeoutError');
    check('時間切れのときに後始末が呼ばれる', cleanedUp, true);
  }

  console.log(`\n結果: 成功 ${passed} 件 / 失敗 ${failed} 件`);
  process.exit(failed === 0 ? 0 : 1);
})();
