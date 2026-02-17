# Chrome Live Screenshot MCP

Bu proje, acik Chrome sekmesinden ekran goruntusu alip MCP tool olarak kullanmanizi saglar.

## Ne Yapar?

- `chrome_list_tabs`: acik sekmeleri listeler
- `chrome_open_url`: acik Chrome oturumunda URL acar/odaklar (yeni Chrome process baslatmaz)
- `chrome_screenshot`: ekran goruntusu alir
  - varsayilan: `artifact` modu (dosyaya yazar, path doner)
  - opsiyonel: `image` modu (base64 image doner)
- `chrome_artifact_cleanup`: eski screenshot dosyalarini temizler
- Eklenti ayni anda birden fazla MCP endpoint'ine baglanabilir ve komutlari global yarissiz FIFO sirasinda isler

## Hizli Kurulum

### 1) Bagimliliklari kur

```bash
npm i
```

### 2) Chrome eklentisini yukle

1. `chrome://extensions` ac
2. `Developer mode` ac
3. `Load unpacked` sec
4. Bu repodaki `chrome-extension/` klasorunu sec
5. Eklenti `Options` ekraninda:
   - Windows-native MCP icin: `ws://localhost:8766`
   - WSL icinde calisan MCP'ye Windows Chrome'dan baglanmak icin: `ws://wsl.localhost:8766`

### Windows + WSL endpoint notu

- Server WSL icinde calisiyorsa varsayilan bind host zaten `0.0.0.0` secilir.
- Eger manuel ayarlamak istersen:

```bash
set MCP_CHROME_WS_HOST=0.0.0.0
set MCP_CHROME_WS_ENDPOINT_HOSTS=wsl.localhost,localhost,127.0.0.1
```

- `chrome-extension/options` tarafinda explicit `WS URL` verdiysen (ornegin `ws://localhost:8766`), bu deger tarama icin seed/priority ipucu olarak kullanilir.
- Eklenti yine lokal host/port havuzunu tarayarak (`localhost`, `127.0.0.1`, `wsl.localhost` + `8766-8775`) birden fazla MCP endpoint'ine ayni anda baglanabilir.
- Bu sayede bir MCP sureci fallback ile farkli porta gecse bile eklenti diger baglantilari kesmeden yakalayabilir.

### 3) Codex'e MCP ekle

```bash
codex mcp add chrome-live-screenshot -- \
  node <ABS_PATH>/node_modules/tsx/dist/cli.mjs \
  <ABS_PATH>/src/index.ts
```

### 4) OpenCode'a MCP ekle

`~/.config/opencode/opencode.json` icine asagidaki kaydi ekle:

```json
"chrome-live-screenshot": {
  "type": "local",
  "command": [
    "node",
    "<ABS_PATH>/node_modules/tsx/dist/cli.mjs",
    "<ABS_PATH>/src/index.ts"
  ],
  "enabled": true
}
```

### 5) Claude Code'a MCP ekle

Proje kokundeki `.mcp.json` dosyasina asagidaki server kaydini ekle:

```json
{
  "mcpServers": {
    "chrome-live-screenshot": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<ABS_PATH>/node_modules/tsx/dist/cli.mjs",
        "<ABS_PATH>/src/index.ts"
      ]
    }
  }
}
```

Sonra Claude Code oturumunu yeniden ac veya MCP listesini yenile.

Public repo notu:

- Makineye ozel `.mcp.json` dosyasini repoya koyma.
- Bunun yerine repodaki `.mcp.example.json` dosyasini kopyalayip lokalde `.mcp.json` olustur.

## Kullanim

### Sekmeleri listele

`chrome_list_tabs` cagir.

### URL ac / odakla

`chrome_open_url` cagir.

- Sadece halihazirda acik olan Chrome oturumu kullanilir
- Yeni bir Chrome process/oturumu baslatilmaz
- Varsayilan davranis: eslesen sekmeyi yeniden kullanir, yoksa mevcut Chrome penceresinde yeni sekme acar
- Gecersiz URL verilirse hata firlatir (varsayilana duser)
- `url` parametresi verilmezse varsayilan `http://localhost:5173/` kullanilir

### Screenshot al (onerilen)

`chrome_screenshot` cagir. Varsayilan olarak dosyaya yazar ve soyle bir veri doner:

- `artifactPath`
- `mimeType`
- `byteSize`
- `width` / `height`

### AI'a resmi gercekten gosterme

Path'i mesaja yazmak tek basina yetmez. Dosyayi attach et:

- Codex: `--image <artifactPath>`
- OpenCode: `--file <artifactPath>`

## Yararlı Argumanlar

`chrome_open_url`:

- `url`
- `match`: `prefix` | `exact`
- `reuseIfExists` (varsayilan `true`)
- `openIfMissing` (varsayilan `true`)
- `focusWindow` (varsayilan `true`)
- `activateTab` (varsayilan `true`)
- `waitForComplete` (varsayilan `true`)
- `timeoutMs`

`chrome_screenshot`:

- `url`
- `match`: `prefix` | `exact`
- `format`: `png` | `jpeg`
- `jpegQuality`: `0-100`
- `returnMode`: `artifact` (varsayilan) | `image`
- `artifactDir`: custom cikti klasoru

`chrome_artifact_cleanup`:

- `maxAgeHours` (varsayilan 24)
- `artifactDir` (opsiyonel)

## Sık Karsilasilan Sorunlar

### "Extension is not connected"

- Eklenti acik mi kontrol et
- Windows-native icin WS URL `ws://localhost:8766` mi kontrol et
- WSL senaryosunda WS URL `ws://wsl.localhost:8766` deneyin
- MCP surecini yeniden baslat

### "MCP startup timeout"

`~/.codex/config.toml`:

```toml
[mcp_servers.chrome-live-screenshot]
startup_timeout_sec = 45.0
```

### "You installed esbuild for another platform"

- Bu hata genelde ayni proje klasorunu hem Windows hem WSL'de calistirirken olur.
- Artik `npm run dev`, `npm test`, `npm run build` oncesi otomatik kontrol/rebuild dener.
- Yine de devam ederse aktif ortamda su komutu bir kez calistir:

```bash
npm rebuild esbuild
```

### "Either '<all_urls>' or 'activeTab' permission is required"

Eklentiyi reload et (`chrome://extensions`) ve son manifest izinlerinin yansidigini kontrol et.
