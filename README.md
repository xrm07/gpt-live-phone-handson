# GPT-Live Phone Hands-on

Vonageから自分の携帯電話へ発信し、日本語でGPT-Liveと会話するTypeScriptのハンズオンです。Liveモードでは、携帯への発信・日本語会話・終了時の使用量通知を確認済みです。

## 使うもの

| 要素                       | 役割                                              |
| -------------------------- | ------------------------------------------------- |
| Vonage Voice API           | 携帯へ電話をかけ、通話音声をWebSocketへつなぐ     |
| TypeScriptの中継サーバー   | VonageとOpenAIの間で音声を送受信する              |
| Cloudflare Quick Tunnel    | ローカルの中継に一時的なHTTPS/WSSの接続先を与える |
| OpenAI GPT-Live            | 音声で会話する。モデルは`gpt-live-1`              |
| OpenAI Responses API       | GPT-Liveが委譲した処理を会話用モデルで実行する    |
| Node.js / tsx / TypeScript | 実行環境 / TypeScriptの実行 / 型検査              |

```text
あなたの携帯 ← 電話回線 → Vonage
                            ↕ 暗号化WebSocket：WSS（一時URL）
                    Cloudflare Quick Tunnel
                            ↕ localhost
                    TypeScriptの音声中継
                            ↕ WebSocket
                     GPT-Live → Responses
```

## 始める前に

- Node.js 22以上、npm、`cloudflared`を用意してください。手順はLinux/macOSのターミナルを想定しています。[cloudflaredの導入](https://developers.cloudflare.com/tunnel/downloads/)
- VonageのAPIアカウントを用意し、自分の携帯番号を認証します。試用中は登録・認証済み番号へ発信してください。
- OpenAI APIの残高と、Live・Responsesの利用権限を持つAPIキーを用意します。
- 費用はVonageの電話回線・音声中継、OpenAIのLive・Responsesの利用分に分かれます。試用条件と料金は各社のダッシュボードで確認してください。

## 1. 設定と鍵を用意する

このREADMEがあるディレクトリで実行します。

```bash
npm ci
npm run setup
```

`.env`、中継用トークン、`.local/`内のRSA鍵ペアが生成されます。既存の設定や鍵は上書きしません。

Vonageのダッシュボードで次を設定します。

1. **Applications → Create a new application**を開き、名前を付けます。
2. **Enter public key**で`.local/vonage-public.pem`の公開鍵を登録します。
3. **Voice**を有効にして作成し、Application IDを控えます。このサンプルは発信要求に通話指示を含めるため、回答URL・イベントURLは空欄で進められます。
4. `.env`の`VONAGE_APPLICATION_ID`と`PHONE_NUMBER`を設定します。電話番号は国番号から始め、日本なら先頭の0を外して81を付けます。
5. `VONAGE_FROM`の既定値で拒否される場合は、ダッシュボードの**Make a Voice Call → From**に表示された試用番号を使います。

発信に使うのはApplication IDと`.local/vonage-private.key`の秘密鍵です。アカウントのAPIシークレットとは異なります。[Vonageの準備手順](https://developer.vonage.com/en/voice/voice-api/getting-started)

`.env`の`OPENAI_API_KEY`も設定してください。`BACKEND_MODEL`の既定値は`gpt-5.6-luna`です。変更する場合は、自分のプロジェクトで利用でき、GPT-LiveのResponses委譲に対応するモデルを選びます。

## 2. 中継と一時URLを用意する

ターミナルを3つ使います。Aは中継、Bはトンネル、Cは発信用です。いずれも同じプロジェクトのディレクトリを開いてください。

中継を起動する前に、短い試験では`.env`に`MAX_SECONDS=30`を設定します。Vonageが中継へ接続してから30秒で終了します。これは料金上限の指定ではありません。

ターミナルAで中継を起動します。

```bash
npm run start:live
```

`Bridge ready on localhost:8787 (live)`が出たら、ターミナルBでトンネルを起動します。

```bash
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

表示された`https://...trycloudflare.com`のURLを`.env`の`PUBLIC_URL`に設定します。URLはトンネルを起動し直すたびに変わります。

`/health`は発信前に中継の状態を確認するためのURLで、認証なしで`ok`・`mode`・`active`・`used`を公開します。音声用の`/audio`は、セットアップで生成した中継用トークンをBearerトークンとして送り、認証します。[Quick Tunnelの説明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 3. 自分の携帯へ発信する

ターミナルCで設定を確認します。このコマンドだけでは発信しません。

```bash
npm run call:live
```

本人の携帯を手元に置いて、1回発信します。

```bash
npm run call:live -- --dial
```

応答して「こんにちは、聞こえますか？」と話してみてください。中継に`GPT-Live session ready`が表示され、返事が聞こえて、自分の発言に沿って会話が進めば成功です。

着信しない・音が返らない場合は、[Troubleshooting](docs/troubleshooting.md)で切り分けます。

## 4. 終了と再試験

1. 携帯から通話を切り、中継に`Final Live usage`が出ることを確認します。表示されなければOpenAIのUsageでも確認します。
2. ターミナルAとBをCtrl+Cで終了します。トンネル停止後、一時URLは使えなくなります。
3. VonageのVoice LogsとOpenAIのUsageで、通話終了・時間・利用料金を確認します。
4. 不要になった試験用キーは失効させます。

中継は認証済みの接続を1回だけ受け付けます。接続後に失敗した場合も、再発信前に再起動してください。発信結果が不明な場合は、再発信する前にVonageの通話ログを確認します。

`MAX_SECONDS`が空欄ならLive通話は180秒です。1〜300秒で設定でき、変更後は中継を再起動します。電話回線全体の上限は、案内音声の分を含めてその値＋15秒です。課金時間は各社の計測と課金単位に従います。

## コードを読む・変更する

構成と音声処理は[Architecture](docs/architecture.md)を参照してください。

```bash
npm run typecheck
npm test
npm run check:public
npm run format:check
```

この4つは電話も外部APIも呼びません。

ライセンスは[MIT](LICENSE)です。
