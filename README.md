# Otoiro

Tauri アプリに組み込む、フロントエンドとバックエンドがセットになったオーディオプレイヤー部品です。
デコードと再生はネイティブ Rust 側で行い、WebView 側は表示と操作だけを担当します。

- サンプル単位の再生クロック（デバイスに渡したサンプル数＋出力遅延から位置を算出）
- 波形タイムライン付きのシークバー
- 回すと音が鳴るジョグダイヤル（グレイン方式のスクラブ再生）。拍・小節単位で動かせる
- 音量の起伏からセクションの区切りとサビ（盛り上がり）を推定し、波形上に表示・ジャンプ
- タグ・ジャケット表示と、ジャケットの色から作る配色テーマ
- ジャケットの無い曲は、音の明るさから配色とアートワークを生成

## 構成

```
crates/
  otoiro/                ネイティブ再生エンジン（symphonia + rubato + cpal）。Tauri 非依存
  tauri-plugin-otoiro/   エンジンを `plugin:otoiro|*` コマンドと ipc::Channel で WebView に公開
packages/
  ui/                    @otoiro/ui: Player クライアント＋Web Components（フレームワーク非依存）
examples/
  demo/                  Tauri v2 + Vite + TypeScript のデモアプリ
```

## 使い方

### Rust（ホストアプリ）

```toml
[dependencies]
tauri-plugin-otoiro = { git = "https://github.com/msdshsk/otoiro" }
```

```rust
tauri::Builder::default().plugin(tauri_plugin_otoiro::init())
```

capabilities に `"otoiro:default"` を追加します。

### フロントエンド

npm は Git リポジトリのサブディレクトリを直接インストールできないため、リポジトリを取り込んで（git submodule など）`file:` で参照します。

```json
"dependencies": { "@otoiro/ui": "file:../otoiro/packages/ui" }
```

```ts
import { Player, getWaveform } from "@otoiro/ui";

const player = await Player.connect();
const seekbar = document.querySelector("oto-seekbar")!;
seekbar.player = player;
document.querySelector("oto-transport")!.player = player;

await player.load("C:/music/song.flac");
seekbar.waveform = await getWaveform("C:/music/song.flac");
```

`@otoiro/ui` は TypeScript のソースをそのまま公開しているので、Vite などのバンドラ経由で使ってください。

バンドラを使わないアプリ（`withGlobalTauri` で素の JS を読み込む構成など）向けに、依存を同梱した 1 ファイルの ES モジュールもビルドできます。

```sh
npm run build -w packages/ui   # → packages/ui/dist/otoiro-ui.js
```

```js
import { Player } from "./vendor/otoiro-ui.js";
```

### ウィジェット

| 要素 | 内容 |
|---|---|
| `<oto-seekbar>` | ホバーで時刻表示、ドラッグでプレビューして離した時点でシーク（Esc で取消）、←/→ で ±5 秒、PageUp/PageDown でセクション移動。`waveform` を渡すと波形表示に切り替わり、セクションの区切りと★（サビ）を表示する。`nextSection()` / `previousSection()` / `jumpToHighlight()` |
| `<oto-transport>` | 再生／一時停止、経過時間／全体時間、音量 |
| `<oto-jog>` | ジョグダイヤル。縦ドラッグ（10 px で 1 ノッチ）かホイールで回すと、その位置の音を短く鳴らしながら移動する（ホイールは下で進む）。1 ノッチの単位は `unit`（`beat`＝既定 / `bar` / `section` / `second` / `frame`）。`section` は `sections` で渡した区切りへ移動する。拍は `bpm` から求め、不明なら 0.5 秒。Shift で一段粗く（拍→小節など）、Ctrl でフレーム単位。下のチップで単位を切り替え、`unitLabels` で表示文字列を変更できる。中央ボタンで再生／一時停止 |

見た目は CSS 変数（`--oto-accent`, `--oto-accent-2`, `--oto-base`, `--oto-glow`, `--oto-track`, `--oto-wave-height` など）と `::part()` で変更できます。
`applyPalette()` と `registerPaletteProperties()` を使うと、曲ごとの配色をアニメーション付きで切り替えられます。

## 再生位置の扱い

- 出力デバイスは開いたままにし、一時停止中は無音を書き込むだけにする
- シークは demuxer のシーク機能で行い、キューに残った古い音声は世代番号で破棄する
- セクション推定は、0.1 秒ごとの音量を平滑化し、前後 4 秒の平均音量の差が大きい点を区切りとする。各区間の音量と密度（ゼロ交差率）からサビを選ぶ。曲構造の厳密な解析ではなく、盛り上がりへ素早く飛ぶための目安
- スクラブは「指定位置へシーク→約 70 ms をフェード付きで再生→一時停止」を 1 単位とし、連続で呼ぶとテープを擦るような音になる
- バックエンドは状態変化時と 250 ms ごとにスナップショットを push し、UI は `Player.position()` で毎フレーム補間する（ポーリングしない）

## 開発

```sh
npm install
npm run dev                                           # デモ起動
cargo run -p otoiro --example play -- <file> [seek秒]  # エンジン単体の確認
cargo run -p otoiro --example info -- <file>          # タグ・波形解析の確認
cargo run -p otoiro --example scrub -- <file> [開始秒]  # スクラブの確認
npm run typecheck
```

## 今後の予定

- ギャップレス再生（次のトラックを同じキューに先読み）
- 出力デバイスの切り替え・既定デバイス変更への追従
- 動画対応（libmpv の埋め込み）

## ライセンス

[MIT](LICENSE)
