# バーコードリーダー（iPhone向けWebアプリ）

iPhoneのSafariで開いて、カメラで商品バーコード（JAN/EAN）やQRコードを読み取り、
番号を表示・コピーできるWebアプリです。インストール不要で、ホーム画面に追加すればアプリのように使えます。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面の骨組み |
| `style.css` | 見た目 |
| `script.js` | カメラ操作と読み取りの処理 |
| `manifest.json` / `*.png` | ホーム画面に追加したときのアイコンや名前 |
| `lib/` | 読み取りライブラリ本体（ZXing）とそのライセンス文 |
| `test/` | 読み取りが正しく動くか確かめるテスト |

読み取りには [ZXing](https://github.com/zxing-js/library) というライブラリ（v0.21.3）を使っています。
外部のCDNから読み込むのではなく `lib/` に置いたものを読み込んでいます。配信元が改ざんされる心配がなく、通信なしでも動くためです。

また、外部との通信を一切しない設定（Content-Security-Policy）を入れてあります。
このため、`index.html` をファイルとして直接開くのではなく、必ず下記のようにサーバー経由で開いてください。

## 動かし方

```bash
python3 -m http.server 8765   # このフォルダで実行
```

ブラウザで `http://localhost:8765/` を開きます。

**注意**: カメラは `https://` か `localhost` でしか使えません（ブラウザの安全のための決まり）。
iPhoneの実機で試すときは、GitHub Pages などの https のURLから開いてください。

## テスト

```bash
node test/decode.test.js
```

番号がわかっているバーコード画像を読ませて、期待どおりの結果が出るか確認します。
ブラウザやカメラがなくても実行できます。

テスト用の画像を作り直したいときは:

```bash
pip install python-barcode qrcode pillow
python3 test/make_fixtures.py
```

## iPhoneで使うときのコツ

- バーコードから **10〜20cmほど離す** とピントが合います（近すぎるとボケます）
- 明るい場所のほうが読み取りやすいです
- Safariの共有ボタン →「ホーム画面に追加」でアイコンが作れます
- 初回はカメラの使用許可を聞かれるので「許可」を選んでください

## 使用しているソフトウェアと権利表記

このアプリは [ZXing (zxing-js/library)](https://github.com/zxing-js/library) v0.21.3 を同梱しています。
ライセンス文は [lib/ZXing-LICENSE.txt](lib/ZXing-LICENSE.txt) を参照してください
（npmの表記はMIT、同梱文書はApache License 2.0 です）。

「QRコード」は株式会社デンソーウェーブの登録商標です。

上記以外の部分（HTML・CSS・JavaScript・アイコン）は、このリポジトリの作者が作成したもので、
MITライセンス（[LICENSE](LICENSE)）で公開しています。

## 制限

- App Storeには出せません（Webアプリのため）
- 読み取った内容はどこにも送信されません（すべて端末の中で処理しています）
- カメラ機能には iOS 14.3 以降のSafariが必要です
- 読み取り履歴はページを閉じると消えます（保存はしていません）
