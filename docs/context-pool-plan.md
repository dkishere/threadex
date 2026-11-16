# Context Pool MVP 計劃（草稿）

狀態：草稿，2026-11-02。來源：
[初始討論](threadex://threadex/tx_e807463d-6df9-6cf7-778d-396be51a6e41/rt_c221d0a77975af54001fc01b870960bd)、
[決策補充](threadex://threadex/tx_e807463d-6df9-6cf7-778d-396be51a6e41/rt_21b70206-1676-471e-9fca-b1b9ba9fa5f1)、
加密 detail 嘅 round table（AstraXH、OpusXH）。

## 問題

### 使用場景

AI provider 越嚟越多，功能同模型升級好快，用戶可能每三幾個月就轉一次主力工具，甚至同時用幾個
agent 產品（Claude Code、Codex、ChatGPT、Claude.ai、Threadex actor）。

- **Context 唔相通好麻煩：** 每個工具都有自己嘅記憶，互相睇唔到、版本唔一致。一轉工具，或者同時用幾個，
  就要重複交代偏好、決策同項目背景，舊工具累積落嚟嘅記憶亦會困死喺嗰個 provider 度。
- **完全相通又會係資安災難：** 如果每個 agent 都讀寫得到全部資料，一個被注入或者有漏洞嘅 agent，
  就可以讀走或者污染所有私人 context；而撤銷權限亦收唔返已經讀過嘅內容。
- **所以要一個統一協議同平台：** 資料由用戶擁有、集中管理，每個 agent 按最小權限攞到需要嘅部分；
  轉工具時，只係加一個 client、撤銷一個 client，唔使搬資料。

Threadex 舊版 context pool 已經併入 actor memory，但 actor memory 只限 Threadex 內部使用，
而且每個 actor 只讀得到自己嘅 memory，解決唔到跨 provider 嘅問題。

### 例子：每個 agent 有自己可操作嘅領域

| Agent profile | 可操作領域 | 動作 |
|---|---|---|
| 公司 Claude account | `coding`、`business` | 讀寫 |
| 私人 Claude account | `coding`、`side-projects` | 讀寫 |
| Uber Eats | `food`（例如過敏） | 只讀 |

由呢幾個例子睇到幾樣要求：

- **領域會重疊：** 兩個 Claude account 都用 `coding`，但 `business` 同 `side-projects` 只限各自一方。
  同一個 provider 會有兩個 account，所以 profile 要按 account 分，唔可以按 provider 分；plan 入面「每個 profile 一條 URL」正好用嚟分開佢哋。
- **共用領域係洩漏渠道：** 公司 account 將公司 codebase 嘅細節寫入共用嘅 `coding`，私人 account 就讀得到，
  等於公司資料流入私人 agent，反方向都一樣。所以每個 profile 要有一個「主領域」：
  佢新寫嘅內容預設落主領域（公司 account 落 `business/…`）；要升做共用 `coding` 嘅條目，就要用戶確認（T2）。
  共用 `coding` 只放通用嘅慣例同偏好。
- **Hosted 服務都要用敏感資料：** 過敏屬於健康資料，但 Uber Eats 喺雲端運行，行唔到本機 helper，
  亦唔應該攞到成個 `health`。做法係由用戶揀一個**最少披露嘅分享視圖**，例如一條「食物過敏清單」，
  放喺 `food/` 下面、用「一般」級別，畀 Uber Eats 讀；詳細病歷繼續留喺端到端加密嘅 `health/`。
  分享視圖由用戶確認內容，來源條目更新之後要標記成過時，等用戶重新確認。
- **第三方服務預設只讀：** Uber Eats 呢類服務最多只可以提出建議（例如「你成日叫呢類嘢」），唔可以直接寫。
- **公司資料嘅擁有權：** `business` 嘅內容可能屬於公司，放入個人雲端 pool 可能違反公司政策；
  公司 account 嘅對話亦可能畀公司 admin 睇到或者保留。呢點要用戶自己確認（D8）。
- **Uber Eats 只係例子：** 佢有冇提供 agent 或 MCP 接入，未查證。同類服務要求嘅只係
  「hosted、範圍窄、只讀、讀敏感資料嘅一小部分」。

### 由場景推導出嚟嘅設計原則

1. **Provider 中立：** 資料格式同 API 語意由 pool 自己定義成開放協議（節點、條目、envelope、grant、
   分級狀態），MCP、REST、SDK 只係傳輸方式，唔綁死任何一家 provider。
   將來出現新協議，只需要加一層 adapter。
2. **接入同退出都要平：** 新 agent 喺幾分鐘內接入並攞到指定子樹；停用嘅 agent 一鍵撤銷。
   完整匯出係標準格式，脫離平台都讀得返。
3. **預設最小權限：** 新 client 預設乜都睇唔到，要逐個子樹授權；敏感子樹要另外加密。
   「相通」係用戶揀出嚟嘅，唔係預設。
4. **多個 agent 同時寫入：** 逐條儲存加樂觀鎖，唔好成段覆寫；每條記低係邊個 agent 寫。
5. **資料比工具長命：** 條目要記錄來源同適用範圍，就算寫入嘅 agent 已經停用，資料依然有效，亦追溯得到。

## 目標（睇得到嘅結果）

一個個人用、雲端部署嘅 context pool：

1. Agent A（例如 Claude Code）寫入一條有來源嘅 context；Agent B（另一個廠商）獲授權後讀到並接手，
   唔使用戶再交代一次。
2. B 發現同現有條目矛盾時，會按分級規則處理（自動、喺對話入面問用戶，或者等用戶批准）；
   更新之後 A 再讀，會攞到新版本。
3. 敏感子樹嘅 detail 喺雲端只有密文；數據庫被 dump，都讀唔到 detail 同敏感分類名。
4. 每個 agent 只讀寫到授權畀佢嘅子樹；撤銷之後，佢攞唔到新資料。
5. 轉工具唔使搬資料：接入一個新 agent，只需要加 client、授權子樹，佢就即刻用到現有 context；
   停用舊 agent 之後，佢寫過嘅條目依然可以讀同追溯。

## 已定決策

- MVP 先俾個人用，部署喺雲端。
- Agent 自行決定寫咩、寫去邊，但建議問用戶；至於幾時一定要問，由 server 嘅分級規則決定，唔係靠 Skill 提醒。
- 舊 context pool 係因為併入 actor 先刪除，唔代表分類方向失敗。
- Detail 加密；雲端只保存必要嘅明文 metadata（見「資料模型」）。
- Skill 只負責教 agent 點用；權限由 server 執行，加解密由 SDK／helper 做，唔交畀 LLM 自己做。

## 未定決策（P0 要先答）

| # | 問題 | 建議預設 |
|---|---|---|
| D1 | 加密主要防邊個：數據庫外洩、hosting 供應商，定係為將來做 SaaS 防營運者？（三樣都防唔到模型廠商） | 防數據庫外洩加 hosting 供應商；格式預留畀 SaaS 用 |
| D2 | ChatGPT／Claude.ai 網頁版需唔需要讀敏感 detail？ | 唔需要直接讀：敏感子樹只限本機 agent；hosted 產品或服務要用嘅部分，由用戶揀出最少披露嘅分享視圖，用「一般」級別畀佢哋讀（例如 Uber Eats 讀過敏清單） |
| D3 | 遺失 key 就永久冇咗資料，接唔接受？ | 接受，但強制設定 recovery key 同支援匯出 |
| D4 | Threadex 繼續喺本機行，定搬上雲？ | 本機：Threadex 兼任 key helper；Threadex 只將已確認嘅 decision 單向發布上雲（方案 B） |
| D5 | 樹按主題分，定係每個節點就係一個 actor？ | 按領域分（`coding`、`business`、`side-projects`、`food`、`health`…），因為用戶就係按領域授權畀 agent；節點格式參考 actor memory，但唔將 `rolePrompt` 當指令執行 |
| D6 | Pool 同 actor memory 共用儲存，定係經 API 連接？ | 經 API 連接；共享資料用固定 ID 同版本互相引用，唔好各存一份 |
| D7 | 程式碼放喺邊個 repo？ | 開新 repo；Threadex 只做 client 同 helper 嘅整合 |
| D8 | 公司 account 寫嘅 `business` 內容可唔可以放入個人雲端 pool？ | 要用戶按公司政策確認；未確認之前，`business` 只存索引同連結，唔存公司內容 |
| D9 | 手機 app 做原生 app，定 PWA？ | 原生 app（iOS 先做）。手機要獨立保管 key、離線讀寫、用 Secure Enclave 簽名，原生 app 最穩陣；PWA 嘅儲存喺 iOS 可能會被系統清走，而推送同 passkey 嘅支援程度亦未驗證。代價係多一套代碼；加密同協議層要同 helper 共用同一份 spec 同測試向量 |

## 架構

```text
Claude Code / Codex / Threadex ──本機 MCP proxy──┐
                                                ├─ 本機 helper（key、加解密、secret 掃描、index cache）
用程式驅動嘅 agent ─────────SDK──────────────────┘            │
                                                              ▼ 密文 + 明文 metadata
ChatGPT / Claude.ai ──遠端 MCP（OAuth，每個 profile 一條 URL）──► Cloud pool API ◄── Web UI（WebCrypto）
                         只讀「一般」子樹                                │  ▲
                                                        推送（只有 id）  ▼  │ 已簽名嘅批准／拒絕
                                                                    手機 app（受信任裝置）
```

- **Cloud pool API：** 以 REST 為核心，遠端 MCP 只係一層薄 adapter。負責授權、版本、分級、稽核、
  envelope 格式檢查、匯出同刪除；睇唔到加密 detail。
- **本機 helper：** 唯一持有 key 嘅元件。對 agent 只提供 `read(nodeId)`、`search(query)`、
  `propose(...)` 呢類操作，唔提供「攞 key」。
- **本機 MCP proxy：** 加解密對 LLM 透明；Skill 只描述呢啲操作點用。
- **SDK：** 畀用程式驅動嘅 agent 用；同 helper 共用同一套加密實作。
- **手機 app：** 獨立嘅完整 client：自己輸入 secret 解鎖，喺本機讀寫 context，亦係快速批准或拒絕
  T1／T2 請求嘅主要入口（見「手機 app」）。

## 手機 app

### 獨立解鎖

- **唔使靠其他裝置：** 喺手機輸入 passphrase 或 recovery key，用 Argon2id 之類嘅慢 KDF 衍生出 master key，
  再解開 KEK。亦可以由已有裝置掃 QR code 加入，兩種方法任揀一種。
- **解鎖之後：** Master key 或者 KEK 用 Secure Enclave／Keychain 包住，之後用 Face ID／Touch ID 打開，
  唔使每次再輸入 secret。Secret 本身唔會儲存，亦唔會上傳。
- **風險：** 任何裝置只要有 passphrase 就解得到鎖，所以數據庫一旦外洩，被包住嘅 key 可以畀人離線暴力破解。
  對策係用慢 KDF，並且建議用系統生成嘅高強度 recovery key，唔好只靠自己諗嘅短密碼。
- **手機唔見咗：** 喺其他裝置或者 Web UI 撤銷佢，再換 KEK；佢 cache 咗嘅舊資料依然存在，同撤銷 agent 一樣。

### 本機讀寫

- **瀏覽同搜尋：** 喺手機本機解密 index 同 detail；本機 cache 都係加密存放。
- **用戶自己寫：** 喺手機新增或修改條目，喺本機加密之後先上傳；條目狀態直接係 `confirmed`，
  來源記做「用戶（手機）」，並用裝置 key 簽名。呢類條目係可信度最高嘅來源，可以用嚟確認或推翻 agent 寫嘅
  `user_stated_unverified` 條目。
- **管理授權：** 喺手機加或撤銷 agent profile、改子樹授權、編輯分享視圖（例如過敏清單）。
  因為係用戶自己操作，唔使另外審批，但高風險操作（擴大授權、降低加密級別、修改分享視圖）都要 Face ID。
- **離線：** 冇網絡都可以讀 cache 同寫入，改動排隊等上傳。有網絡之後用樂觀鎖同步；
  遇到版本衝突就喺手機顯示兩個版本畀用戶揀，唔會自動覆寫。

### 審批

目標：agent 發出請求之後，用戶喺手機幾秒內就可以批准或拒絕，唔使返去電腦。

- **通知入面冇明文：** 推送只帶 request id 同級別。APNs／FCM 同鎖定畫面都睇唔到內容；
  app 收到之後先攞密文，喺手機本機解密顯示。
- **批准要簽名：** 每次批准或拒絕，都用手機 passkey／Secure Enclave 嘅裝置 key 簽名；
  簽名內容包括 request id、條目版本同內容 hash。Server 驗證簽名先執行，所以 server 偽造唔到批准，
  亦唔可以將一個批准套落另一個請求。
- **快慢分流：**
  - T1 確認同低風險 T2（例如升做共用領域）：通知或 app 入面一撳就批准或拒絕。
  - 高風險 T2（改授權、降低加密級別、建立或修改分享視圖、刪除已確認條目）：要打開 app 睇清楚 diff，
    再用 Face ID／Touch ID 確認，鎖定畫面唔提供一撳批准。
- **一次過處理：** 同一個 agent 喺短時間內發出嘅同類請求合併成一張卡，可以全部批准或者逐條揀。
- **Agent 唔使等：** 請求停喺 pending 嘅時候，agent 收到「pending」狀態，繼續做其他嘢；
  請求逾時（例如 24 小時）就當拒絕，條目保留做 `proposal`。
- **防「全部批准」：** 每日審批次數係一個量度指標；請求太多，代表分級劃錯，應該調整規則，
  唔好鼓勵用戶開「always allow」。

## 資料模型

逐條儲存（唔再用一整段字串），讀嘅時候先砌返做 markdown。

| 層級 | 欄位 |
|---|---|
| 必須明文 | opaque node id、parent id、版本、狀態（proposed／confirmed／superseded）、`supersedes`、寫入 profile、時間、key id、加密級別 |
| 逐個子樹揀 | 分類名（敏感子樹預設加密） |
| 一定加密 | detail、摘要、tags、來源原話、`roleSummary` 類 index 文字 |

- 唔好用 detail 頭 256 bytes 做明文 index。
- 加密之後 server 仍然睇到資料大小、時間同存取模式；文件同 UI 要寫明。

## 寫入分級

| 級別 | 範圍 | 處理 |
|---|---|---|
| T0 | 自己 profile 子樹入面嘅 rolling／scratch | 直接寫；14 日內冇升級就自動過期 |
| T1 | decision／preference | 喺對話入面問用戶；要附用戶原話同來源，標記 `user_stated_unverified`，放入摘要畀用戶一鍵確認或還原；agent 自己提出嘅只可以記做 `proposal` |
| T2 | 覆寫或刪除已確認條目、跨子樹搬移、將條目由主領域升做共用領域、開頂層節點、改授權、寫入敏感子樹、切換加密級別、建立或修改分享視圖 | 停喺 pending，要用戶喺平台 Web UI 批准 |

矛盾處理：較新嘅唔會自動贏。舊條目已確認過就升做 T2；兩條都未確認，就由 agent 決定，但兩條都保留，用 `supersedes` 連住。

## 加密

- 用成熟 library 嘅 AEAD（XChaCha20-Poly1305 或 AES-GCM），唔好自創方案。AAD 綁定 node id、版本、key id 同所屬子樹。
- Key 分層：每條資料一把 DEK → 子樹 KEK → master key。Master key 由 passphrase／recovery key 衍生，或者存喺裝置 Keychain。
- 子樹 KEK 跟授權 profile 分配，咁就算 server 授權出錯，都解唔到其他子樹。
- 撤銷：換 KEK，重新包住所有 DEK。對方已經讀過或者 cache 咗嘅內容收唔返，UI 要講清楚。
- 防回退：helper 記住每個 node 見過嘅最新版本。明文 metadata 冇簽名，server 有可能搬 node 或改名；MVP 暫時接受呢個風險，並寫入文件。
- Server 拒收唔係合法 envelope 嘅 detail，防止 agent 漏咗加密就將明文寫上雲。
- Secret 掃描喺 helper 入面、加密之前做。

## Key 保管：點樣令 agent 睇唔到 key

**現實限制：** agent 有 shell，又同 helper 用同一個 OS 用戶行，要佢完全睇唔到 key 好難。
key 放喺 env 或者檔案，agent 一句 `env`、`cat` 就攞到；prompt injection 亦可以叫佢咁做。
所以目標分級處理，並講清楚每級防到乜：

| 級別 | 做法 | 防到 | 防唔到 |
|---|---|---|---|
| K0 | Key 放 env／檔案，agent 自己讀得到 | 只防雲端 | Agent 或注入內容直接讀走 key；只限開發用 |
| K1 | Helper 由 launchd／Threadex 獨立啟動，唔係 agent 嘅子進程；key 存喺只信任 helper binary 嘅 Keychain item；agent 只經 Unix socket 或本機 MCP 調用 | Agent 唔會喺 env 或檔案睇到 key；用 `security` CLI 讀 key 會彈出提示畀用戶 | 被注入嘅 agent 仍然可以叫 helper 解密已授權子樹，再將明文帶走 |
| K2 | KEK 用 Secure Enclave／passkey 包住，解開要 Touch ID | Key 無法匯出 | 同 K1 一樣，已解密嘅明文仍然可能被帶走 |

- MVP 目標係 K1；K2 留到之後再做。
- 要做到 K1，key 千祈唔好由 agent 經 env 傳畀 helper；agent 嘅 sandbox 亦應該禁止讀 key 檔同 helper 嘅資料目錄。
  不過 sandbox 可以被 agent 申請解除，所以唔可以當成唯一防線，主要靠 Keychain ACL。
- 收埋 key 只係防止 key 被長期偷走、或者越過授權範圍使用，防唔到 session 入面嘅明文外洩。
  後者要靠：helper 按 profile 限制子樹、每次解密記錄稽核、設定速率上限，同埋一個 session
  解密量異常時通知用戶。
- 待驗證：Keychain ACL 同提示喺 helper binary 更新之後嘅行為；各 agent sandbox 能唔能夠准用 socket、同時禁止讀 key 檔。

## 加密級別（逐個子樹揀）

| 級別 | Server 睇到乜 | 邊啲 client 讀到 | 例子 |
|---|---|---|---|
| 一般 | 處理時睇到內容（server 端 KMS envelope 加密） | 全部，包括網頁版 | Coding 慣例、工具偏好 |
| 端到端加密 | 只有明文 metadata | 只限有本機 helper 嘅 agent | 健康、財務、私人項目 |

「一般」子樹可以用 server 端搜尋同便宜模型整理記憶；端到端加密子樹嘅搜尋同整理喺 helper 做。

## 分階段實作（Solution）

- **P0 決策：** 答 D1–D7，定 repo 同技術棧。
- **P0.5 協議草案：** 用一份 provider 中立嘅 spec 寫清楚資料模型、envelope 格式、grant、分級狀態同匯出格式；
  MCP tool 同 REST endpoint 都由呢份 spec 對應出嚟。
- **P1 Cloud pool 核心：** 節點、條目、envelope 嘅資料模型；REST API；「profile × 子樹前綴 × 動作 × 到期時間」grant 表，
  每個 profile 加一個主領域；分享視圖（用戶確認嘅最少披露條目，來源更新後標記過時）；
  樂觀鎖；稽核 log；envelope 格式檢查；完整匯出同徹底刪除。
- **P2 本機 helper + MCP proxy + SDK + Skill：** K1 key 保管、AEAD/AAD、key 分層、index 拉落本機解密再 cache、
  版本 high-water mark、加密前 secret 掃描、recovery key。
- **P3 寫入分級同審批：** T0／T1／T2 判斷、pending 隊列、逾時當拒絕、每日或每週確認摘要；
  Web UI 做桌面版審批。
- **P3.5 手機 app（D9）：** 用 secret 獨立解鎖，或者掃 QR code 加入；Secure Enclave 保管 key；本機加密 cache；
  瀏覽、搜尋同讀寫條目；離線排隊同步加衝突處理；管理授權同分享視圖；只帶 id 嘅推送、裝置簽名批准、快慢分流、合併請求；
  裝置撤銷。
- **P4 遠端 MCP：** OAuth；每個 profile 一條 URL；短 access token 加 refresh token；只開放「一般」子樹。
- **P5 Threadex 整合：** Threadex 做 client；已確認嘅 decision 單向發布上雲（D4 方案 B）；如果 D4 揀本機，就由 Threadex 兼任 helper。
- **P6 自己試用：** 用 Claude Code、ChatGPT 同 Threadex 跑「目標」入面嘅流程。

## 驗證（Verification）

- **接手流程：** Claude Code 寫入、ChatGPT（一般子樹）或 Codex（加密子樹）讀到並接手；矛盾時觸發對應級別；A 再讀攞到新版本。
- **數據庫外洩：** 直接 dump 數據庫，加密子樹嘅 detail 同分類名都冇明文。
- **防調包：** 將 `work` 條目嘅密文當成 `health` 條目回傳，helper 拒絕。
- **防回退：** Server 回傳舊版本，helper 報錯。
- **漏加密：** 用明文 detail 直接 call API，server 拒收。
- **Key 唔外露（紅隊測試）：** 叫 agent 印出 key、行 `env`、讀 helper 資料目錄、用 `security` CLI 讀 key；
  再用一條藏有注入指令嘅 detail 重測。預期 key 唔會出現喺 transcript 入面，Keychain 會彈出提示；明文外洩只限已授權子樹，而且有稽核記錄。
- **領域隔離：** 公司 Claude profile 讀唔到 `side-projects/`，私人 Claude profile 讀唔到 `business/`；
  兩個都讀到共用嘅 `coding/`。公司 profile 新寫嘅內容落 `business/`；要升做 `coding/` 就會停喺 pending。
- **分享視圖：** Uber Eats profile 只讀到 `food/` 嘅過敏清單，讀唔到 `health/`；寫入一律被拒；
  來源病歷更新之後，過敏清單標記過時，等用戶重新確認。
- **授權同撤銷：** `work-coding` profile 讀唔到 `health/`；撤銷之後攞唔到新版本；KEK 換咗之後，舊 key 解唔到新寫入嘅資料。
- **手機審批：** Agent 發出 T2 請求，手機喺幾秒內收到通知；通知同推送 payload 入面冇明文；
  app 顯示解密後嘅 diff；一撳批准之後 server 驗證簽名先執行。Server 偽造或者重用簽名會被拒絕；
  高風險請求冇 Face ID 就批准唔到；逾時之後當拒絕，條目保留做 `proposal`。
- **手機獨立解鎖：** 喺一部全新手機只輸入 recovery key，就讀得到已授權嘅子樹；secret 冇儲存喺手機，亦冇上傳；
  之後用 Face ID 就打開到。
- **手機本機讀寫：** 喺手機新增條目，server 收到嘅係密文，條目狀態係 `confirmed`，有裝置簽名；
  其他 agent 讀到嘅係新版本。離線時改同一條條目，另一部裝置又改咗，同步時會顯示衝突畀用戶揀。
- **手機管理授權：** 喺手機撤銷 Uber Eats profile 之後，佢即刻讀唔到 `food/`；冇 Face ID 就擴大唔到授權。
- **手機遺失：** 撤銷裝置之後，佢簽嘅批准會被拒絕；KEK 換咗之後，部手機解唔到新資料。
- **遺失 key：** 用 recovery key 還原；匯出檔可以獨立解密。
- **轉工具：** 加一個未用過嘅 agent，計時由接入、授權子樹到用到現有 context；之後撤銷舊 agent，
  確認佢攞唔到新資料，而佢寫過嘅條目依然讀得到、追溯得到來源。
- **多個 agent 同時寫：** 兩個 agent 同時寫入同一子樹嘅唔同條目，兩條都保留；同時改同一條，
  其中一個會收到版本衝突，唔會靜靜雞覆寫。
- **Provider 中立：** 匯出檔脫離平台，用 spec 同 recovery key 就讀得返。
- **指標：** 少交代幾多次；慳到嘅時間有冇被確認或修正記憶嘅時間抵消；每日問用戶次數（T2 一日超過幾次，代表分級劃錯）；讀取命中率；過時條目比例。

## MVP 唔做

團隊共享、公開 marketplace、大量 connector、自動分類、向量搜尋（先用全文搜尋）、明文 metadata 簽名、K2 硬件 key、
Android app（iOS 先做）。

## 風險

- 端到端加密子樹網頁版讀唔到，同「跨廠商」目標有拉扯；要靠 D2 決定。
- Agent 唔主動用個 pool；Skill 指引同使用率要一齊量度。
- 「每個 profile 一條 URL」喺各個 client 行唔行得通未測試；ChatGPT 個人方案可唔可以用 MCP 寫入，資料互相矛盾。
- 解密之後嘅內容一樣會送去模型廠商；文件同 UI 唔可以聲稱防到廠商。
