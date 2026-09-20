# テスト用のバーコード画像を作るスクリプト
#   使い方: pip install python-barcode qrcode pillow && python3 test/make_fixtures.py
# PNG（目で見て確認する用）と、.bin/.json（Node.jsのテストで読み込む用）を出力します。
import json
import os

import barcode
from barcode.writer import ImageWriter
import qrcode
from PIL import Image

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(HERE, exist_ok=True)


def dump(name, img, expected, fmt):
    """PNGと、Node.jsから読める白黒データ(.bin)＋情報(.json)を保存する"""
    png_path = os.path.join(HERE, name + ".png")
    img.save(png_path)
    gray = img.convert("L")  # 白黒（明るさだけ）に変換
    with open(os.path.join(HERE, name + ".bin"), "wb") as f:
        f.write(gray.tobytes())
    meta = {"width": gray.width, "height": gray.height, "expected": expected, "format": fmt}
    with open(os.path.join(HERE, name + ".json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("作成:", name, meta)


# 商品バーコード（JAN/EAN-13）。最後の1桁（チェックデジット）は自動計算される
ean = barcode.get("ean13", "490123456789", writer=ImageWriter())
ean_img = ean.render()
dump("ean13", ean_img, ean.get_fullcode(), "EAN_13")

# QRコード
qr_img = qrcode.make("https://example.com/test").convert("RGB")
dump("qr", qr_img, "https://example.com/test", "QR_CODE")

# 何も写っていない画像（「読み取れない」ことを確かめる用）
dump("blank", Image.new("RGB", (300, 200), "white"), None, None)
