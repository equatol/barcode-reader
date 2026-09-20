// ===== バーコードリーダー =====
// カメラ映像を1枚ずつ画像として取り込み、ZXingライブラリで解析します。
// 映像の取り込みはライブラリ任せにせず自分で行っています（ライブラリの該当機能は
// 開発元が非推奨としており、映像サイズの扱いに問題があるため）。

// ライブラリが読み込めていない場合は、無反応にならないよう理由を画面に出して止める
if (typeof ZXing === 'undefined') {
  const statusEl = document.getElementById('status');
  const startEl = document.getElementById('startBtn');
  if (statusEl) statusEl.textContent = '読み取りライブラリを読み込めませんでした。ページを再読み込みしてください';
  if (startEl) startEl.disabled = true;
  throw new Error('ZXing library is not loaded');
}

const {
  MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource,
  DecodeHintType, BarcodeFormat,
} = ZXing;

const APP_VERSION = 'v5'; // 画面に表示して、新しい版が読み込まれているか確認するため

// 画面の部品をまとめて取得しておく
const els = {
  video: document.getElementById('preview'),
  guide: document.getElementById('guide'),
  placeholder: document.getElementById('placeholder'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  result: document.getElementById('result'),
  resultFormat: document.getElementById('resultFormat'),
  resultText: document.getElementById('resultText'),
  resultLink: document.getElementById('resultLink'),
  copyBtn: document.getElementById('copyBtn'),
  status: document.getElementById('status'),
  diag: document.getElementById('diag'),
  fileInput: document.getElementById('fileInput'),
  historyArea: document.getElementById('historyArea'),
  history: document.getElementById('history'),
};

// 読み取り対象のコード形式をあらかじめ絞る（絞ったほうが速く・正確に読めます）
const FORMATS = [
  BarcodeFormat.EAN_13,   // 商品バーコード（日本のJANコードはこれ）
  BarcodeFormat.EAN_8,    // 短いタイプの商品バーコード
  BarcodeFormat.UPC_A,    // アメリカの商品バーコード
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, // 配送伝票などでよく使われる
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,  // QRコード
];

function createHints() {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true); // 多少ぼやけていても粘って読む
  return hints;
}

// 解析役。映像の取り込みには関わらない、純粋な解析部分だけを使う
const coreReader = new MultiFormatReader();
coreReader.setHints(createHints());

// カメラの状態: 'idle'（停止中）/ 'starting'（起動中）/ 'scanning'（読み取り中）
let cameraState = 'idle';
// 起動処理の通し番号。起動を待っている間に停止されたかどうかを見分けるために使う
let sessionId = 0;
let scanTimer = null;
let currentStream = null;
let lastText = '';
let lastTime = 0;
let audioCtx = null;

// 動作確認用の情報
let decodeAttempts = 0;
let lastBrightness = '-';
let diagTimer = null;

// 読み取り用の作業領域（映像1コマを描き写す場所）
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

// ---------- 読み取りの中核（ここが一番大事な部分） ----------

// カラー画像を白黒の明るさデータに変換する。
// 人の目は緑を明るく感じるため、緑に大きめの重みを付けるのが一般的な計算方法です。
function toLuminance(rgba, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 151 + rgba[j + 2] * 28) >> 8;
  }
  return out;
}

// 明るさの幅を調べる（真っ黒な映像が取り込まれていないかの確認用）
function brightnessRange(luminances) {
  let min = 255;
  let max = 0;
  // 全部調べると遅いので、飛ばしながら確認する
  for (let i = 0; i < luminances.length; i += 37) {
    const v = luminances[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// 「読み取れなかった」だけの、無視してよいエラーかどうか
function isHarmlessDecodeError(err) {
  return err instanceof ZXing.NotFoundException
    || err instanceof ZXing.ChecksumException
    || err instanceof ZXing.FormatException;
}

// 明るさデータを90度回転させる（縦向きに印刷されたバーコードに対応するため）
function rotate90(luminances, width, height) {
  const out = new Uint8ClampedArray(luminances.length);
  // 回転後は幅と高さが入れ替わる
  for (let ny = 0; ny < width; ny++) {
    for (let nx = 0; nx < height; nx++) {
      out[ny * height + nx] = luminances[(height - 1 - nx) * width + ny];
    }
  }
  return out;
}

// 明るさデータからコードを読み取る。読み取れない場合は例外が投げられます。
function decodeLuminance(luminances, width, height) {
  const source = new RGBLuminanceSource(luminances, width, height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  return coreReader.decodeWithState(bitmap);
}

// 画像データからコードを読み取る。読み取れない場合は例外が投げられます。
function decodeImageData(rgba, width, height) {
  const luminances = toLuminance(rgba, width, height);
  const range = brightnessRange(luminances);
  lastBrightness = `${range.min}-${range.max}`;

  try {
    return decodeLuminance(luminances, width, height);
  } catch (err) {
    if (!isHarmlessDecodeError(err)) throw err;
    // そのままでは読めなかったので、90度回してもう一度試す
    return decodeLuminance(rotate90(luminances, width, height), height, width);
  }
}

// ---------- 画面表示まわりの小さな関数 ----------

function setStatus(message) {
  els.status.textContent = message;
}

// 読み取り結果を画面に出す
function showResult(text, format) {
  els.resultFormat.textContent = format;
  els.resultText.textContent = text;

  // QRコードの中身がURLなら、リンクとしても表示する
  if (/^https?:\/\//i.test(text)) {
    els.resultLink.href = text;
    els.resultLink.hidden = false;
  } else {
    els.resultLink.hidden = true;
  }

  els.result.hidden = false;
  addHistory(text, format);
}

// 履歴に追加する（最大10件。ページを閉じると消えます）
function addHistory(text, format) {
  const li = document.createElement('li');
  li.textContent = text;
  const span = document.createElement('span');
  span.className = 'history-format';
  span.textContent = `${format} / ${new Date().toLocaleTimeString('ja-JP')}`;
  li.appendChild(span);

  els.history.prepend(li);
  while (els.history.children.length > 10) {
    els.history.removeChild(els.history.lastChild);
  }
  els.historyArea.hidden = false;
}

// 読み取れたときの合図の音
// （iPhoneのSafariはWebページから振動させられないので、代わりに短い音を鳴らします）
function beep() {
  try {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.08);
  } catch (e) {
    // 音が鳴らせなくても読み取り自体には影響しないので、何もしない
  }
}

// 同じコードを何度も拾い続けないように、直前と同じ値は3秒間は無視する
function isDuplicate(text) {
  const now = Date.now();
  if (text === lastText && now - lastTime < 3000) return true;
  lastText = text;
  lastTime = now;
  return false;
}

// 読み取り成功時の共通処理
function handleResult(result) {
  const text = result.getText();
  const format = BarcodeFormat[result.getBarcodeFormat()];
  if (isDuplicate(text)) return;
  beep();
  showResult(text, format);
  setStatus('読み取りました');
}

// 読み取れないときに原因がわかるよう、動作状況を表示する
function startDiagnostics() {
  stopDiagnostics();
  diagTimer = setInterval(() => {
    const w = els.video.videoWidth || 0;
    const h = els.video.videoHeight || 0;
    els.diag.textContent =
      `${APP_VERSION} ／ 映像 ${w}×${h} ／ 試行 ${decodeAttempts}回 ／ 明るさ ${lastBrightness}`;
    els.diag.hidden = false;
  }, 500);
}

function stopDiagnostics() {
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = null;
  els.diag.hidden = true;
}

// ---------- カメラの開始／停止 ----------

// 映像を再生し、サイズが確定するまで待つ
async function startVideo(video, stream) {
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', 'true'); // iPhoneで全画面プレーヤーにしない
  await video.play();
  if (!video.videoWidth) {
    // サイズがまだわからない場合は、わかるまで待つ
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
    });
  }
}

// 映像から1コマ取り込む。まだサイズが確定していない場合は null を返す
function captureFrame() {
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  if (!w || !h) return null;
  if (captureCanvas.width !== w || captureCanvas.height !== h) {
    captureCanvas.width = w;
    captureCanvas.height = h;
  }
  captureCtx.drawImage(els.video, 0, 0, w, h);
  return captureCtx.getImageData(0, 0, w, h);
}

// 読み取りを繰り返す
function scanLoop(mySession) {
  if (mySession !== sessionId) return; // 停止されたので終了

  let result = null;
  try {
    const frame = captureFrame();
    if (frame) {
      decodeAttempts++;
      result = decodeImageData(frame.data, frame.width, frame.height);
    }
  } catch (err) {
    if (!isHarmlessDecodeError(err)) {
      stopCamera();
      setStatus('読み取り中に問題が起きました: ' + (err && err.message ? err.message : err));
      return;
    }
  }

  // 表示の処理は try の外で行う（表示の失敗を読み取り失敗と混同しないため）
  if (result) handleResult(result);

  scanTimer = setTimeout(() => scanLoop(mySession), 120);
}

async function startCamera() {
  // HTTPS（暗号化された通信）でないとカメラは使えません
  if (!window.isSecureContext) {
    setStatus('カメラを使うには https:// で開く必要があります');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('このブラウザはカメラに対応していません');
    return;
  }

  // 音は「ユーザーがボタンを押した」タイミングでないと準備できないので、ここで作る
  // 古いiOSのSafariでは webkitAudioContext という別名になっている
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx && AudioCtx) audioCtx = new AudioCtx();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  setStatus('カメラを準備しています…');
  els.startBtn.disabled = true;

  const mySession = ++sessionId; // この起動処理の通し番号
  cameraState = 'starting';
  let stream = null;

  // facingMode: 'environment' = 背面カメラ。解像度を上げると細いバーコードが読みやすくなる
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };

  try {
    // カメラの使用許可を取る（利用者が許可を押すまで待つので、時間制限はかけない）
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (mySession !== sessionId) { releaseCamera(stream); return; }

    currentStream = stream;

    // 他のアプリにカメラを奪われるなどで映像が終わったときに気づけるようにする
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (mySession !== sessionId) return;
        stopCamera();
        setStatus('カメラの映像が途切れました。もう一度「カメラを起動」を押してください');
      });
    });

    // 映像の再生開始を待つ。低電力モードなどで始まらないことがあるので10秒で打ち切る
    await withTimeout(startVideo(els.video, stream), 10000);
    if (mySession !== sessionId) { releaseCamera(stream); return; }

    cameraState = 'scanning';
    decodeAttempts = 0;
    lastBrightness = '-';
    startDiagnostics();
    els.placeholder.hidden = true;
    els.guide.hidden = false;
    els.startBtn.hidden = true;
    els.stopBtn.hidden = false;
    setStatus('バーコードを枠の中に映してください（10〜20cmほど離すとピントが合います）');

    scanLoop(mySession);
  } catch (err) {
    releaseCamera(stream);
    stopDiagnostics();
    if (mySession !== sessionId) return; // 利用者が止めた場合はエラー扱いしない
    cameraState = 'idle';

    if (err && err.name === 'NotAllowedError') {
      setStatus('カメラの使用が許可されませんでした。Safariの設定から許可してください');
    } else if (err && err.name === 'NotFoundError') {
      setStatus('カメラが見つかりませんでした');
    } else if (err && err.name === 'TimeoutError') {
      setStatus('カメラの映像を開始できませんでした。低電力モードを解除して、もう一度お試しください');
    } else {
      setStatus('カメラを起動できませんでした: ' + (err && err.message ? err.message : err));
    }
  } finally {
    els.startBtn.disabled = false;
  }
}

// カメラを解放する
function releaseCamera(stream) {
  const target = stream || currentStream;
  if (target) target.getTracks().forEach((track) => track.stop());
  if (target === currentStream) currentStream = null;
  els.video.srcObject = null;
}

function stopCamera() {
  sessionId++; // 起動処理や読み取りの繰り返しを止める
  cameraState = 'idle';
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  stopDiagnostics();
  releaseCamera();
  els.guide.hidden = true;
  els.placeholder.hidden = false;
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  setStatus('停止しました');
}

// ---------- 画像ファイルから読み取る ----------

// いつまでも終わらない処理を、指定時間で打ち切るための関数
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      const err = new Error('TIMEOUT');
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

// 画像を読み込む。失敗したときもきちんと終わるようにする
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

async function decodeFile(file) {
  setStatus('画像を読み取っています…');
  const url = URL.createObjectURL(file);
  let result = null;
  try {
    const img = await withTimeout(loadImage(url), 10000);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    result = decodeImageData(frame.data, frame.width, frame.height);
  } catch (err) {
    setStatus('この画像からはコードを読み取れませんでした');
  } finally {
    URL.revokeObjectURL(url);
  }

  if (result) {
    lastText = ''; // 画像読み取りは重複チェックの対象外にする
    handleResult(result);
  }
}

// ---------- コピー ----------

async function copyResult() {
  const text = els.resultText.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('コピーしました');
  } catch (err) {
    setStatus('コピーできませんでした。長押しで選択してコピーしてください');
  }
}

// ---------- ボタンと画面の紐づけ ----------

els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.copyBtn.addEventListener('click', copyResult);
els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) decodeFile(file);
  e.target.value = ''; // 同じファイルをもう一度選べるようにする
});

// 別のアプリに切り替えたときはカメラを止める（バッテリー節約とプライバシーのため）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && cameraState !== 'idle') stopCamera();
});
