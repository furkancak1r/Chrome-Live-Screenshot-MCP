# Chrome Live Screenshot MCP

Bu proje, acik Chrome sekmesinden ekran goruntusu alip MCP tool olarak kullanmanizi saglar.

## Ne Yapar?

- `chrome_list_tabs`: acik sekmeleri listeler
- `chrome_screenshot`: ekran goruntusu alir
  - varsayilan: `artifact` modu (dosyaya yazar, path doner)
  - opsiyonel: `image` modu (base64 image doner)
- `chrome_artifact_cleanup`: eski screenshot dosyalarini temizler

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
5. Eklenti `Options` ekraninda `WS URL` degeri: `ws://localhost:8766`

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
- WS URL `ws://localhost:8766` mi kontrol et
- MCP surecini yeniden baslat

### "MCP startup timeout"

`~/.codex/config.toml`:

```toml
[mcp_servers.chrome-live-screenshot]
startup_timeout_sec = 45.0
```

### "Either '<all_urls>' or 'activeTab' permission is required"

Eklentiyi reload et (`chrome://extensions`) ve son manifest izinlerinin yansidigini kontrol et.
