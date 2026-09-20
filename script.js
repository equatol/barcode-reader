// ===== バーコードリーダー =====
// ZXing というライブラリを使って、カメラ映像からバーコード／QRコードを読み取ります。

// ライブラリが読み込めていない場合は、無反応にならないよう理由を画面に出して止める
if (typeof ZXing === 'undefined') {
  const statusEl = document.getElementById('status');
  const startEl = document.getElementById('startBtn');
  if (statusEl) statusEl.textContent = '読み取りライブラリを読み込めませんでした。ページを再読み込みしてください';
  if (startEl) startEl.disabled = true;
  throw new Error('ZXing library is not loaded');
}

// ZXing から必要な部品を取り出す（index.html で読み込んだライブラリ）
const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = ZXing;

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

// カメラ用の読み取り装置
const cameraReader = new BrowserMultiFormatReader(createHints(), 250);
// 読み取れなかったときの次の試行までの間隔（ミリ秒）。
// 初期値は0で、その場合は休みなく読み取り続けてしまい、iPhoneが熱くなり電池も減ります。
cameraReader.timeBetweenDecodingAttempts = 100;

// カメラの状態: 'idle'（停止中）/ 'starting'（起動中）/ 'scanning'（読み取り中）
let cameraState = 'idle';
// 起動処理の通し番号。起動を待っている間に停止されたかどうかを見分けるために使う
let sessionId = 0;
let lastText = '';
let decodeAttempts = 0;   // 読み取りを試した回数（動作確認用）
let diagTimer = null;     // 動作状況を更新するタイマー
let lastTime = 0;
let audioCtx = null;

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
  const format = result.getBarcodeFormat ? ZXing.BarcodeFormat[result.getBarcodeFormat()] : '';
  if (isDuplicate(text)) return;
  beep();
  showResult(text, format);
  setStatus('読み取りました');
}

// 「読み取れなかった」だけの、無視してよいエラーかどうか。
// これ以外のエラーが起きると、ライブラリは読み取りの繰り返しを止めてしまいます。
function isHarmlessDecodeError(err) {
  return err instanceof ZXing.NotFoundException
    || err instanceof ZXing.ChecksumException
    || err instanceof ZXing.FormatException;
}

// ライブラリは「映像を取り込むためのキャンバス」を最初の1回だけ作り、その大きさを使い回します。
// 作られた時点で映像サイズがまだ0だと、0×0のまま固定され、以後永久に何も読み取れません。
// 映像サイズが判明した（または画面回転で変わった）ら、作り直させて自動的に直します。
function fixCaptureCanvasIfBroken() {
  const width = els.video.videoWidth;
  const canvas = cameraReader.captureCanvas;
  if (width > 0 && canvas && canvas.width !== width
      && typeof cameraReader._destroyCaptureCanvas === 'function') {
    cameraReader._destroyCaptureCanvas();
    return true;
  }
  return false;
}

// 読み取れないときに原因がわかるよう、映像サイズと試行回数を表示する
function startDiagnostics() {
  stopDiagnostics();
  diagTimer = setInterval(() => {
    fixCaptureCanvasIfBroken();
    const w = els.video.videoWidth || 0;
    const h = els.video.videoHeight || 0;
    els.diag.textContent = `映像 ${w}×${h} ／ 読み取り試行 ${decodeAttempts}回`;
    els.diag.hidden = false;
  }, 500);
}

function stopDiagnostics() {
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = null;
  els.diag.hidden = true;
}

// カメラの映像と、ライブラリが付けたイベントの後始末をまとめて行う。
// ライブラリ側に消し忘れるイベントがあるため、video要素を作り直して確実に消す。
function releaseCamera(stream) {
  cameraReader.reset();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  const fresh = els.video.cloneNode(false); // 属性だけを引き継ぎ、イベントは引き継がない
  els.video.replaceWith(fresh);
  els.video = fresh;
}

// いつまでも終わらない処理を、指定時間で打ち切るための関数。
// ライブラリの中には「失敗しても何も知らせずに待ち続ける」場合があるため、保険として使います。
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

// ---------- カメラの開始／停止 ----------

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
  if (!audioCtx && AudioCtx) {
    audioCtx = new AudioCtx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  setStatus('カメラを準備しています…');
  els.startBtn.disabled = true;

  // facingMode: 'environment' = 背面カメラ。解像度を上げると細いバーコードが読みやすくなる
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };

  const mySession = ++sessionId; // この起動処理の通し番号
  cameraState = 'starting';
  let stream = null;

  try {
    // カメラの使用許可を先に取る（ここはユーザーが許可を押すまで待つので、時間制限はかけない）
    stream = await navigator.mediaDevices.getUserMedia(constraints);

    // 許可を待っている間に停止されていたら、カメラを片付けて終わる
    if (mySession !== sessionId) {
      releaseCamera(stream);
      return;
    }

    // 他のアプリにカメラを奪われるなどで映像が終わったときに気づけるようにする
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (mySession !== sessionId) return;
        stopCamera();
        setStatus('カメラの映像が途切れました。もう一度「カメラを起動」を押してください');
      });
    });

    // 映像の再生開始を待つ。iPhoneの低電力モードなどで再生が始まらないことがあり、
    // その場合ライブラリは何も知らせずに待ち続けるので、10秒で打ち切る
    await withTimeout(
      cameraReader.decodeFromStream(stream, els.video, (result, err) => {
        if (mySession !== sessionId) return; // 停止後に呼ばれたものは無視する
        decodeAttempts++;
        if (result) {
          handleResult(result);
          return;
        }
        // 「読み取れなかった」以外のエラーが起きると、ライブラリは繰り返しを止めてしまう。
        // 気づかずに映し続けることがないよう、停止して知らせる
        if (err && !isHarmlessDecodeError(err)) {
          stopCamera();
          setStatus('読み取りが中断されました。もう一度「カメラを起動」を押してください');
        }
      }),
      10000
    );

    // 起動を待っている間に停止された場合（他のアプリに切り替えた等）
    if (mySession !== sessionId) {
      releaseCamera(stream);
      return;
    }

    cameraState = 'scanning';
    decodeAttempts = 0;
    startDiagnostics();
    els.placeholder.hidden = true;
    els.guide.hidden = false;
    els.startBtn.hidden = true;
    els.stopBtn.hidden = false;
    setStatus('バーコードを枠の中に映してください（10〜20cmほど離すとピントが合います）');
  } catch (err) {
    // 途中で失敗したときは、カメラを必ず解放する（つけっぱなしを防ぐ）
    releaseCamera(stream);

    stopDiagnostics();

    // 利用者が自分で停止した場合は、エラーとして知らせない
    if (mySession !== sessionId) return;

    cameraState = 'idle';
    // うまくいかなかった理由をわかりやすく伝える
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

function stopCamera() {
  sessionId++; // 起動処理の途中なら、それを無効にする
  cameraState = 'idle';
  stopDiagnostics();
  releaseCamera(); // カメラを解放し、イベントの後始末をする
  els.guide.hidden = true;
  els.placeholder.hidden = false;
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  setStatus('停止しました');
}

// ---------- 画像ファイルから読み取る ----------

async function decodeFile(file) {
  setStatus('画像を読み取っています…');
  const url = URL.createObjectURL(file);
  // カメラ用とは別の読み取り装置を使う（カメラの動作と干渉しないように）
  const fileReader = new BrowserMultiFormatReader(createHints());
  // カメラ用と同じ理由で、再試行の間隔を空ける（0のままだと休みなく処理し続ける）
  fileReader.timeBetweenDecodingAttempts = 100;
  let result = null;
  try {
    // 画像が読み込めない形式だったときなど、ライブラリが待ち続けることがあるので5秒で打ち切る
    result = await withTimeout(
      fileReader.decodeFromImageUrl(url), 5000, () => fileReader.stopAsyncDecode());
  } catch (err) {
    setStatus('この画像からはコードを読み取れませんでした');
  } finally {
    fileReader.reset();
    URL.revokeObjectURL(url);
  }

  // 表示の処理は try の外で行う。
  // 中に入れると、表示で失敗したときに「読み取れませんでした」と誤って出てしまうため
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
