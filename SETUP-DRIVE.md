# Google Driveへの切り替え

公開URL `https://ping-pong-dash-official.netlify.app/` と、GitHubリポジトリ
`ping-pong-dash/artistpage` の連携は維持します。新規サイトは作成しません。

## 現在の状態

- ソースに含まれるメンバー4人、ライブ2件、アルバム5個、写真16枚は維持しています。
- 埋め込み画像19点は再圧縮せず `assets/bundled/` へ移しました。
- Googleの設定が終わるまでは既存コンテンツを表示し、公開データの編集を止めます。
- 以前のlocalStorageは読み取るだけで、初期化・削除しません。
- ローカルの確認用サーバーは `.local-data/` に保存します。実際のDriveには接続しません。

## 1. Google側の初期設定

1. 保存先フォルダの編集権限があるGoogleアカウントで https://script.google.com/ を開き、独立したApps Scriptプロジェクトを作成します。
2. `google-apps-script/Code.gs` の内容をプロジェクトの `Code.gs` に登録します。
3. `setup` 関数を実行し、自分が作成したこのスクリプトへのDriveアクセスを承認します。
4. 保存先は設定済みです。
   https://drive.google.com/drive/folders/1ObCpREIQIO_UZ64P_s-4fM-O364gx7s0
5. 実行後、フォルダ内に `images` と `history` が作成されます。フォルダを一般公開する必要はありません。
6. Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」の `SHARED_SECRET` を、次のNetlify設定で使用します。チャット・GitHub・HTMLには貼り付けません。
7. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」で、実行ユーザーを「自分」、アクセスできるユーザーを「全員」にします。会社等のアカウントでこの選択が禁止されている場合は管理者の設定確認が必要です。
8. `/exec` で終わるウェブアプリURLを控えます。更新時もデプロイを編集して同じURLの新バージョンに切り替えます。

公開されたApps Scriptの入口は署名付きリクエストだけを受け付けます。
ブラウザや訪問者へGoogleの認証情報を渡すことはありません。

## 2. Netlify側の設定

既存プロジェクト `ping-pong-dash-official` の環境変数に次を設定します。
値がFunctionsの実行環境に渡るようにし、秘密値はSecretとして扱います。
環境変数は公開用の `netlify.toml` やGitHubに記載しません。

| 変数名 | 値 |
| --- | --- |
| `PPD_DRIVE_SCRIPT_URL` | 上の `/exec` URL |
| `PPD_DRIVE_SECRET` | スクリプト プロパティの `SHARED_SECRET` |
| `PPD_MEMBER_PASSWORD` | 新しいメンバー共通パスワード。16文字以上。旧デモ用パスワードは使いません |
| `PPD_SESSION_SECRET` | ランダムな秘密文字列。32文字以上 |

`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
で `PPD_SESSION_SECRET` 用のランダム値をローカルで生成できます。

GitHubの既存リポジトリに改修内容を反映します。
ビルドは `npm run build`、公開ディレクトリは `dist` です。
`netlify.toml` はこの設定を含みます。Functionsやテスト、Google側のコードは公開ディレクトリに入りません。
GitHubのproductionブランチを更新すると、従来どおり既存Netlifyプロジェクトがビルドします。
追加の有料プランや自動課金は、この改修では設定しません。

## 3. 既存データの引き継ぎ

1. 本番で写真やライブ情報を編集していた、同じ端末・同じブラウザで、今までの公開URLを開きます。ブラウザの保存データは消さないでください。
2. MEMBER LOGINから新しいパスワードでログインします。
3. 「既存データを引き継ぐ」を選びます。処理前にJSONバックアップがダウンロードされます。
4. ソース内のデータと、このブラウザのlocalStorage・未保存下書きを読み込みます。画像を1枚ずつ保存し、最後に投稿データを確定します。
5. 同じ写真は画像内容のSHA-256でまとめます。既存の公開データがある場合はその内容を優先し、足りない写真・ライブ・アルバムなどを追加します。引き継ぎによる削除は行いません。
6. 「Googleドライブへの引き継ぎ完了」を確認し、別のブラウザでも内容を確認します。

ほかの端末にも保存データがある場合は、その端末でも同じ引き継ぎ処理を実行できます。
または「既存データを書き出す」「バックアップを取り込む」で端末間を移動できます。
別のブラウザにだけあるデータはZIPやGitHubから取り出せないため、そのブラウザでの引き継ぎが必要です。

## 運用

- 写真、ライブ、プロフィールの追加・編集は今までの管理画面から行います。
- 上部の保存状態で確定を確認します。入力後すぐの「自動保存」表示は、通信完了を意味しません。
- 保存失敗時は下書きをIndexedDBに保持します。端末側にも残せない場合は警告するため、バックアップを書き出してください。
- 同時編集の衝突は409として止め、ほかの人の内容を上書きしません。下書きを書き出して再読み込み後、必要な追加分を取り込んでください。
- 初回取り込みを含め、更新ごとに `history` にJSONのスナップショットを残します。
- 写真をアルバムから外してもDriveの原本は削除しません。誤操作からの復旧を優先しています。
- 投稿データと写真は公開サイトの内容です。「ライブ非表示」は秘密情報のアクセス制御ではありません。
- 本番以外のNetlifyデプロイからDriveへの書き込みは拒否します。
- 一般訪問者には公開データを短時間キャッシュし、画像は内容別URLでキャッシュします。
- ブラウザ用のパスワード判定と `ppdAdminLoggedIn` は廃止し、HttpOnlyの期限付きCookieでサーバー認証します。
- Google Driveの空き容量、Apps Scriptの実行制限、Netlifyの転送量・実行量の無料枠には引き続き注意してください。写真の配信もNetlify経由です。無料・無制限の配信を保証する構成ではありません。
- 複数メンバーはサイトの共通パスワードを使います。GoogleやNetlifyの管理アカウントを共有する必要はありません。

## ローカル確認

`npm run dev` で http://127.0.0.1:8001/ を開きます。
Googleの環境変数がなければローカル確認用になり、パスワードは `local-preview-only` です。
最初に「既存データを引き継ぐ」を実行すると編集できます。保存先の状態表示は「ローカル」になります。
Google接続を実際に検証する場合は、別のテスト用Googleフォルダ・Apps Scriptを設定してください。
本番フォルダを使った破壊的なテストは行わないでください。

検証: `npm test` と `npm run build`。

参考:
- https://developers.google.com/apps-script/guides/web
- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/apps-script/reference/lock/lock-service
