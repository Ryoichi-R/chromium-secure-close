# 開発者向け

Chrome / Brave に読み込ませる拡張機能は `extension/` です。`lib/` は外部通信を持たない純粋ロジックとジャーナル、`popup/` と `options/` は `storage.local` のみを使うUIです。`delete_and_close` のwindow集合は通常・ポップアップだけで、`incognito: true` のシークレットウィンドウをpre/post snapshotから除外します。

## 追加機能

- 「安全」「標準」「完全（サイトデータ含む）」の3プリセットをpopup/optionsで選べます。プリセットは削除対象だけを変更し、期間・確認設定・ログイン維持リストは変更しません。
- optionsのログイン維持リストにはoriginを登録できます。Cookie・キャッシュ・サイトストレージだけが除外対象で、履歴・ダウンロード履歴・フォームデータは全体削除対象です。Cookieの保護範囲はregistrable domain単位になり得ます。
- ショートカット `Alt+Shift+C` は削除を開始せずpopupを開きます。競合時はChromeの `chrome://extensions/shortcuts`、Braveの `brave://extensions/shortcuts` で変更してください。
- 設定はschema v2で保存され、既存v1設定は認識済みfieldを維持して正規化されます。v2設定を保存したprofileへ旧v1版を戻すダウングレードは、維持リストが失われる可能性があるため対応しません。

ログイン維持リストの実行は、除外対応データと履歴・ダウンロード履歴・フォームデータを別々の削除stepへ分けます。途中失敗時は `partial` として記録し、ウィンドウを閉じません。

削除APIの `originTypes` は `{ unprotectedWeb: true }` に固定し、hosted appデータと他の拡張機能データを削除対象へ含めません。シークレット領域の閲覧データは対象外であり、シークレットウィンドウの終了も行いません。シークレットウィンドウを開始元にした「削除して閉じる」は拒否し、「削除のみ」を選択します。

popup/optionsの通常保存は変更fieldだけを最新settingsへpatchし、各controller内の書込みqueueで直列化します。Chrome storageにはcross-context CASがないため、完全同時writeのlast-writer-wins自体は保証範囲外です。

ChromeとBraveでは同じManifest V3 extension directoryを読み込めますが、閲覧データの保存・除外動作は専用profileで個別に受入確認してください。Brave内部ページ、Shields内部状態、Rewards関連データは保証対象外です。

## 検証

Node.js 22または24、PowerShell 7.4以上、Pester 5.7以上を使用します。対象フォルダを単独で取得した場合も、`project/`から固定済み依存をclean installして一式を検証できます。

```powershell
cd project
npm ci
npm run check
npm run verify:syntax
npm run verify:ledger
```

個別実行は`npm run build`、`npm test`、`npm run coverage`、`npm run verify:syntax`、`npm run verify:ledger`、`npm run verify:extension`、`npm run verify:policy`を使用します。coverage出力は`project/coverage/`に生成され、公開候補には含めません。

`tests/integration/acceptance_ledger_spec.js`は、公開対象外の`_internal/ACCEPTANCE.md`と親workspaceの`plans/`を検証するowner-private契約です。通常の`npm test`からは除外しますが、`npm run verify:ledger`で専用configを使って必ず実行します。

固定受入fixtureは `createAcceptanceSentinelPair({ port: 51730 })` で `127.0.0.1` と `::1` に同時bindし、一方でも失敗した場合は両listenerを停止して失敗します。

`vitest`と`@vitest/coverage-v8`は同一versionでproject-localな開発依存として固定します。実機受入では日常プロファイルを使わず、Chromeの完全な版と専用プロファイルのパスを`_internal/ACCEPTANCE.md`に記録します。

## 保証範囲

`incognito: "spanning"` を宣言していますが、シークレットウィンドウは削除前後の終了対象から除外します。シークレットウィンドウを開始元にした「削除して閉じる」は明示的に拒否し、「削除のみ」を利用します。

最終ウィンドウの `windows.remove()` が settle する前に worker が停止する可能性があるため、`closing_final_expected` は「終了処理へ移行した」ことだけを示す runnable/provisional 状態です。次回実行を不要にブロックせず、同一operationの観測結果だけを条件付きで精緻化します。

## ライセンス

このプロジェクトの第一者コードは[MIT License](../LICENSE)で公開します。
依存関係およびその他の第三者コンポーネントは、それぞれの権利者が定めるライセンスに従います。
