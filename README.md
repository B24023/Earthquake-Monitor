# 地震観測モニタ

気象庁から発表された地震と各地の観測震度を、独自の日本周辺地図と一覧で表示します。震度は配信された階級を使用し、観測点は詳細データ中の緯度・経度で描画します。速報で地点が未掲載の場合は地域別の最大震度を表示します。

## ローカルで起動

Python 3.11 で動作を確認しています。リポジトリのルートで次のコマンドを実行し、[モニタ](http://127.0.0.1:8000/) を開いてください。

Windows（PowerShell）

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m uvicorn main:app --reload
```

macOS・Linux

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn main:app --reload
```

## 公開環境

公開先では `main:app` を HTTPS の配信環境から起動してください。本番用起動時は `--reload` を外します。表示中は気象庁の地震一覧を約30秒ごとに確認します。ブラウザはサーバーの次回取得時刻に合わせて更新し、タブを表示し直したときにも確認します。画面への反映は気象庁の公開データへの掲載後です。

## データの出典

- [気象庁「地震情報」](https://www.jma.go.jp/bosai/map.html#contents=earthquake_map) の公開データを編集し、地図・一覧を独自に作成しています。[気象庁ホームページの利用規約](https://www.jma.go.jp/jma/kishou/info/coment.html)
- 背景地図は [Natural Earth 1:50m Admin 0 Countries v5.1.2](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson) を日本周辺向けに抽出したものです。[Natural Earth の利用条件](https://www.naturalearthdata.com/about/terms-of-use/)

画面には気象庁の発表後に反映されます。発生時刻・発表時刻・アプリが最後に一覧を取得した時刻をそれぞれ表示します。
