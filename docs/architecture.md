# Architecture

発信要求を送るコマンドと、通話音声を中継するサーバーを別のプロセスで動かします。

## 最初に読むファイル

| ファイル              | 読むと分かること                                            |
| --------------------- | ----------------------------------------------------------- |
| `src/config.ts`       | tts / echo / liveの設定、環境変数の検証、時間上限           |
| `src/vonage.ts`       | Vonageへ渡す通話指示（NCCO）と、秘密鍵で署名するJWTの作り方 |
| `src/call.ts`         | 設定確認と実発信の分岐、発信前の中継チェック                |
| `src/server.ts`       | ローカル待受けとCtrl+Cでの終了                              |
| `src/bridge.ts`       | WebSocketの認証、音声転送、切断処理                         |
| `src/live-session.ts` | GPT-Liveの音声形式・指示・会話用モデルの設定                |

`scripts/`には初期設定、Live接続確認、公開ファイル検査のコマンドがあります。

## 発信から会話まで

1. `call.ts`が設定を検証します。`--dial`がなければここで終わります。
2. `echo`・`live`では一時URLの`/health`を読み、中継のモードと使用済み状態を確認します。
3. `vonage.ts`がApplication秘密鍵でJWTを署名し、`POST /v1/calls`へ発信要求を送ります。JWTは、発信要求を認証するための有効期限付きトークンです。
4. 携帯が応答すると、VonageがNCCOの`talk`で案内を読み上げます。`echo`・`live`では、続く`connect`がWSSで`/audio`へ接続します。
5. 中継はAuthorizationヘッダーのBearerトークンを検証し、音声形式の通知を待ちます。`echo`は受け取ったPCM音声をそのまま返します。
6. `live`はOpenAIへ接続し、`session.start`を送ります。`session.started`後に携帯の音声を転送し、返ってきた音声をVonageへ送ります。
7. 携帯の切断または時間上限で音声転送を止め、Liveに`session.close`を送ります。`session.closed`で使用量通知を受け取り、接続を閉じます。通知が届かない場合の終了期限は後述します。

## 音声の形式

Vonageには `audio/l16;rate=24000`、OpenAIには `audio/pcm`・24,000Hzを指定します。どちらも、この構成ではモノラル・符号付き16bitリトルエンディアンPCMを扱います。

VonageとのWebSocketはバイナリの音声フレームを使います。OpenAIのイベントはJSONなので、音声をBase64文字列にして `session.input_audio.append`へ渡します。返答の `session.output_audio.delta` は逆にBase64からバイナリへ戻します。Base64化はデータの包み方の変更で、音声のサンプルレート変換ではありません。

24,000サンプル/秒×2バイトなので、1秒分の音声は48,000バイトです。OpenAIの起動中は最大3秒分を順番に保持し、起動後に送ります。上限を超えた場合は試験を止めます。

## GPT-Liveと会話用モデル

GPT-Liveは音声でのやり取りを担当し、必要な処理をResponses側のモデルへ委譲します。`sessionStart()`に声と会話スタイルをまとめ、`BACKEND_MODEL`で委譲先を選びます。ツールは空にしてあり、検索や外部操作は行いません。音声セッションとResponsesの利用料は別です。

## 保存・公開・終了の範囲

- ローカルコードは録音ファイルや文字起こしを保存しません。音声の一時バッファと使用量ログを扱います。通話IDなどの運用ログはVonage側にも残ります。
- OpenAIには `store: false` を指定します。これは各社のサービス全体のデータ保持をゼロにする指定ではありません。
- 秘密鍵とOpenAIキーはローカルに置きます。中継用トークンはVonageへの発信要求に含め、WSS接続時の認証に使います。Cloudflareは音声が通る経路に入ります。
- 終了処理では電話とLiveの両方の接続が閉じるまで待ちます。10秒以内に完了しない場合は接続を強制終了します。Ctrl+Cではこの処理を待ち、プロセス全体の終了待ちは最大12秒です。最終使用量を受け取れなかった場合は、Usage画面で確認します。

短い1対1の試験を想定しています。自動再接続・録音管理・運用監視は備えておらず、発話を遮ったときの応答品質は利用環境で確認が必要です。

## 仕様の参照先

- [Vonage: 発信APIの準備](https://developer.vonage.com/en/voice/voice-api/getting-started)
- [Vonage: WebSocketと音声形式](https://developer.vonage.com/en/voice/voice-api/concepts/websockets)
- [Vonage: NCCO](https://developer.vonage.com/en/voice/voice-api/ncco-reference)
- [OpenAI: Live WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets)
- [OpenAI: 委譲とツール](https://developers.openai.com/api/docs/guides/live-delegation)

24kHzはVonageの[WebSocket概念ガイド](https://developer.vonage.com/en/voice/voice-api/concepts/websockets)と実通話での確認に基づきます。NCCOリファレンスのcontent-type欄には8/16kHzのみが記載されており、公式資料間に記載差があります。
