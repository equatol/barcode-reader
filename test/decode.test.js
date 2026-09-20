// バーコード読み取りのテスト
//   使い方: node test/decode.test.js
// ブラウザを使わずに、アプリと同じライブラリ・同じ設定で
// 「既知のバーコード画像が正しく読めるか」を確認します。

const fs = require('fs');
const path = require('path');
const ZXing = require('../lib/zxing-0.21.3.min.js');

const { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource,
        DecodeHintType, BarcodeFormat } = ZXing;

const APP_DIR = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

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

// --- アプリと同じ読み取り設定を作る ---
function createReader() {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
    BarcodeFormat.ITF, BarcodeFormat.QR_CODE,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

// 白黒データ（.bin）を読み込んで、ライブラリが扱える形にする
function loadFixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
  const gray = fs.readFileSync(path.join(FIXTURES, `${name}.bin`));
  const source = new RGBLuminanceSource(
    new Uint8ClampedArray(gray), meta.width, meta.height);
  return { meta, bitmap: new BinaryBitmap(new HybridBinarizer(source)) };
}

function decode(name) {
  const { meta, bitmap } = loadFixture(name);
  const reader = createReader();
  try {
    // decode() ではなく decodeWithState() を使う。
    // decode() は設定（読み取るコードの種類の指定）を消してしまい、
    // アプリの実際の動作（decodeWithState）と違う結果になるため
    const result = reader.decodeWithState(bitmap);
    return { meta, text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] };
  } catch (err) {
    return { meta, text: null, format: null }; // 読み取れなかった
  }
}

console.log('■ 画像からの読み取り');
for (const name of ['ean13', 'qr']) {
  const r = decode(name);
  check(`${name}: 読み取った文字`, r.text, r.meta.expected);
  check(`${name}: コードの種類`, r.format, r.meta.format);
}
{
  // 何も写っていない画像では、誤検出せずに「読み取れない」となること
  const r = decode('blank');
  check('blank: 何も検出しない', r.text, null);
}

{
  // 「QRコードだけ読む」設定にしたら、商品バーコードは読まれないこと。
  // これが通らない場合、読み取るコードの種類の指定が効いていない
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]]]);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  const { bitmap } = loadFixture('ean13');
  let read = null;
  try {
    read = reader.decodeWithState(bitmap).getText();
  } catch (err) {
    read = null;
  }
  check('読み取る種類の指定が効いている', read, null);
}

console.log('■ iPhoneで動かすために必要な設定');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(APP_DIR, 'script.js'), 'utf8');
// playsinline が無いと、iPhoneでカメラ映像が全画面プレーヤーになってしまう
check('video に playsinline がある', /<video[^>]*\splaysinline/.test(html), true);
check('背面カメラを指定している', js.includes("facingMode"), true);
check('マニフェストを読み込んでいる', html.includes('rel="manifest"'), true);
check('apple-touch-icon がある', fs.existsSync(path.join(APP_DIR, 'apple-touch-icon.png')), true);
// hidden属性が確実に効くようにしておく（display指定のあるクラスに打ち消されるのを防ぐ）
const css = fs.readFileSync(path.join(APP_DIR, 'style.css'), 'utf8');
check('[hidden] を隠す指定がある', /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css), true);
// アプリが読み込むライブラリと、テストが使うライブラリが同じファイルか
const scriptSrc = (html.match(/<script src="([^"]*zxing[^"]*)"/) || [])[1];
check('ライブラリを自分のサイトから読んでいる', scriptSrc, 'lib/zxing-0.21.3.min.js');
check('そのファイルが実在する', fs.existsSync(path.join(APP_DIR, scriptSrc || '')), true);
check('外部CDNを読み込んでいない', /src="https?:/.test(html), false);

// 読み取りを休みなく繰り返さない設定（iPhoneの発熱・電池対策）が入っているか
check('カメラ側に再試行の間隔がある', /cameraReader\.timeBetweenDecodingAttempts\s*=/.test(js), true);
check('画像側に再試行の間隔がある', /fileReader\.timeBetweenDecodingAttempts\s*=/.test(js), true);

// withTimeout（処理が終わらないときに打ち切る仕組み）を script.js から取り出して実際に動かす
(async () => {
  console.log('■ 時間切れの安全装置');
  const matched = js.match(/function withTimeout[\s\S]*?\n}\n/);
  check('withTimeout が定義されている', Boolean(matched), true);

  if (matched) {
    const withTimeout = eval('(' + matched[0] + ')');

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
  }

  console.log(`\n結果: 成功 ${passed} 件 / 失敗 ${failed} 件`);
  process.exit(failed === 0 ? 0 : 1);
})();
