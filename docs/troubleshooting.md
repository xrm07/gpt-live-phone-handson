# Troubleshooting

以下は問題の切り分けに使う任意の手順です。発信・着信は読み上げ（`tts`）、音声中継は自分の声を返すエコー（`echo`）、AI接続は`check:live`で確認します。

## 着信しない・すぐ切れる

Vonageの **Logs → Voice Logs** で、最新のCall ID、時刻、ステータスを確認します。`busy` / `remote_busy` / SIP 486は、相手が話し中、または着信を拒否した応答です。コードだけでiPhone・通信会社・経路のどこが原因かまでは確定できません。[Vonageの説明](https://api.support.vonage.com/hc/en-us/articles/209591618-What-does-xxx-SIP-call-status-mean)

iPhoneなら、集中モード、保存していない発信者のスクリーニング／消音、着信判定アプリを確認します。試験のため設定を変える場合は元の状態を控え、実験後に戻してください。着信履歴の有無、番号表示、実際に音や画面が出たかも切り分けに使います。[Appleの案内](https://support.apple.com/ja-jp/111106)

通話ログが`Answered`でも留守番電話が応答した可能性があります。本人が応答して音声を聞くところまで確認してください。

## 試用から発信できない

`PHONE_NUMBER`が登録・認証済みの本人の番号か、試用残高があるかを確認します。`VONAGE_FROM`はダッシュボードが案内する試用番号を使います。

`401`などの認証エラーならApplication IDと秘密鍵の組を確認します。

## 読み上げで着信を確認する

着信や電話回線だけを確認する場合に使います。中継・トンネル・OpenAIへの接続は不要です。Vonageの通話料金は発生します。

```bash
npm run call:tts
npm run call:tts -- --dial
```

本人が応答し、日本語の案内が聞こえることを確認して切ります。

## エコーで音声の往復を確認する

着信するのにLive通話の音声が聞こえない場合、OpenAIを使わずに中継までを確認できます。Vonageとトンネルは使います。

1. Live通話の中継を止め、ターミナルAで`npm run start:echo`を実行します。
2. 同じポートのトンネルを使い、ターミナルCから次を実行します。

```bash
npm run call:echo
npm run call:echo -- --dial
```

応答して話し、自分の声が返れば音声の往復は成功です。`MAX_SECONDS`が空欄ならエコーは30秒で終了します。Live通話へ戻すときはエコーの中継を止め、`npm run start:live`で起動し直します。どちらのモードも、次の発信前に中継の再起動が必要です。

### エコーで声が返らない

1. 中継の`http://127.0.0.1:8787/health`が応答するか確認します。ポートを変更した場合は、その番号を使います。
2. トンネルが動いていて、`.env` の `PUBLIC_URL` が現在のURLか確認します。
3. `Phone audio connected (echo, PCM16 24kHz)` が出るか確認します。
4. `unsupported audio format`なら、`src/vonage.ts`と`src/live-session.ts`の24kHz設定を確認します。

中継の `used` がtrueなら再起動が必要です。`.env`のトークンや時間上限を変えた場合も、中継を再起動します。`/health`が応答しても、音声用の認証付きWebSocketに接続できるとは限りません。

## GPT-Liveにつながらない

`npm run check:live`で、電話をかけずにLiveの接続を確認できます。短い課金対象セッションを作り、`session started`と`finalized`が出ればセッションの開始と終了を確認できています。会話の成立は、携帯で応答して別途確認します。接続できない場合は、キーの期限、API残高、Live・Responses権限、モデル利用権限を確認します。ブラウザのChatGPT利用枠と、APIの残高は別です。

`GPT-Live session ready`が出たのに音が返らない場合は、最初に短く話し、Vonageの通話時間と中継の終了理由を確認します。`startup audio buffer exceeded`は、AI起動待ちの音声が3秒分を超えた状態です。`backpressure`は送信待ち音声が上限を超えた状態です。どちらもサーバーを再起動してから再試験します。
