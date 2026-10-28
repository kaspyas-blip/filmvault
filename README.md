# 🎬 FilmVault – kino z Jellyfinu v Discordu

> **English:** A Discord bot that streams movies and series from your [Jellyfin](https://jellyfin.org) server into a voice channel via Go Live, controlled with slash commands. Resume, auto next episode, track selection, HDR tone mapping and watch history included. The bot UI is in Czech.

Napíšeš `/pust Zohan` a film se za pár vteřin objeví v hlasovém kanálu jako živé vysílání. Všichni v hovoru se dívají spolu, kdo má oprávnění, může pauzovat, přetáčet nebo měnit dabing a titulky.

## Co umí

- **Vyhledávání a výběr** – `/pust` s našeptáváním, `/filmy` s filtrem žánru, roku a českého dabingu, `/serialy` s výběrem série a dílu
- **Ovládání** – pauza, posun (`1:20:00`, `+5`, `-30s`), tlačítka pod zprávou, změna zvukové stopy a titulků za běhu
- **Navazování** – pokračuje tam, kde jste skončili, pozice se ukládá do Jellyfinu
- **Další díl** – po dohrání dílu seriálu sám pustí další se stejným jazykem
- **Čeština napřed** – bez výběru vezme český dabing (a české vynucené titulky), jinak české titulky
- **Historie** – `/videli` ukáže, co běželo, kdo to pustil a kde jste skončili; přes `/zapsat` jde přidat ručně a z nabídky odebrat
- **HDR filmy** se převádí na normální barvy (jinak by v Discordu byly vybledlé)
- **Nápověda** se sama připne do textového kanálu

## Jak to funguje

```
Discord (/pust)  ──►  ovládací bot  ──►  Jellyfin API (hledání, stopy, pozice)
                          │
                          ▼
                       ffmpeg  ◄──  film z Jellyfinu (HTTP)
         (zmenšení na 720p, titulky, HDR → SDR, H.264 + Opus)
                          │
                          ▼
              streamovací účet  ──►  Go Live v hlasovém kanálu
```

Bot jsou ve skutečnosti **dva Discord účty v jednom programu**:

- **ovládací bot** – oficiální bot, přijímá slash příkazy a ukazuje tlačítka a seznamy,
- **streamovací účet** – obyčejný uživatelský účet ovládaný programem (selfbot). Ten se připojí do hovoru a vysílá film přes Go Live, což oficiální boti neumí.

Video převádí ffmpeg, ideálně na grafické kartě (Intel Quick Sync, NVIDIA NVENC), takže stačí i malý počítač.

## ⚠️ Riziko

Ovládání uživatelského účtu programem (selfbot) **porušuje podmínky používání Discordu**. Na streamování proto použij samostatný, nový účet, ne svůj hlavní. Pokud ho Discord zablokuje, založ nový a vyměň `STREAMER_TOKEN`. Projekt je určený pro soukromé servery s přáteli.

## Co budeš potřebovat

- **Jellyfin server** s filmy nebo seriály (třeba na Raspberry Pi nebo NASu)
- **Počítač, na kterém poběží bot** – Windows nebo Linux, stačí i mini PC. Grafika Intel nebo NVIDIA hodně pomůže, bez ní to zvládne procesor, jen pomaleji.
- **[Node.js](https://nodejs.org) 22.4 nebo novější**
- **[ffmpeg](https://ffmpeg.org/download.html)** – na Windows třeba build od [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (verze *full*, obsahuje i `zscale` pro HDR)
- **Discord server**, kde máš právo přidávat boty
- **Druhý Discord účet** pro streamování

## Instalace krok za krokem

### 1. Jellyfin

1. V Jellyfinu otevři **Ovládací panel → Klíče API** a vytvoř nový klíč (třeba „FilmVault“). Ten půjde do `JELLYFIN_API_KEY`.
2. Doporučeno: v **Ovládací panel → Uživatelé** založ uživatele `Kino`. Pod ním si kino ukládá, co je rozkoukané a zhlédnuté, a nemíchá se to s tvým vlastním sledováním. Jméno půjde do `JELLYFIN_USER`.

### 2. Ovládací bot

1. Otevři [Discord Developer Portal](https://discord.com/developers/applications) a klikni na **New Application**.
2. V sekci **Bot** klikni na **Reset Token** a token si zkopíruj. Půjde do `BOT_TOKEN`. Nikomu ho neukazuj.
3. V sekci **OAuth2 → URL Generator** zaškrtni scopes `bot` a `applications.commands` a oprávnění:
   *View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Pin Messages*.
4. Vygenerovaný odkaz otevři a bota přidej na svůj server.

### 3. Streamovací účet

1. Založ nový Discord účet (třeba `filmvault`) a pozvi ho na server.
2. Zjisti jeho token podle návodu knihovny [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13#get-token-). Půjde do `STREAMER_TOKEN`.

### 4. Kanály na serveru

Vytvoř textový kanál pro příkazy (výchozí název `filmsearch`) a hlasový kanál pro promítání (výchozí `film`). Pokud chceš, aby kino ovládali jen někteří, vytvoř roli (třeba `kino`) a dej ji jim.

### 5. Stažení a instalace bota

```bash
git clone https://github.com/kaspyas-blip/filmvault.git
```

```bash
cd filmvault
```

```bash
npm install
```

### 6. Nastavení

Zkopíruj `.env.example` jako `.env` a vyplň ho:

| Položka | Co tam patří |
| --- | --- |
| `BOT_TOKEN` | token ovládacího bota (krok 2) |
| `STREAMER_TOKEN` | token streamovacího účtu (krok 3) |
| `TEXT_CHANNEL`, `VOICE_CHANNEL` | název nebo ID textového a hlasového kanálu |
| `GUILD_ID` | ID serveru – jen pokud je ovládací bot na víc serverech |
| `JELLYFIN_URL` | adresa Jellyfinu, např. `http://192.168.1.50:8096` |
| `JELLYFIN_API_KEY` | API klíč (krok 1) |
| `JELLYFIN_USER` | uživatel Jellyfinu pro kino, např. `Kino` |
| `FFMPEG_PATH` | cesta k ffmpeg, nebo jen `ffmpeg`, pokud je v PATH |
| `VIDEO_ENCODER` | `h264_qsv` (Intel), `h264_nvenc` (NVIDIA), `libx264` (procesor) |
| `HW_DECODE` | `d3d11va` (Windows), `cuda` (NVIDIA), `vaapi` (Linux), `0` = procesor |
| `VIDEO_HEIGHT`, `VIDEO_FPS` | bez Discord Nitra nejvýš `720` a `30` |
| `VIDEO_BITRATE` | datový tok videa v kb/s, `2500` je dobrý kompromis |
| `ALLOWED_ROLE_ID` | ID nebo název role, která smí ovládat kino (prázdné = všichni) |

ID kanálu, serveru nebo role zkopíruješ, když v Discordu zapneš **Nastavení → Pokročilé → Režim vývojáře** a klikneš na kanál, server nebo roli pravým tlačítkem → **Kopírovat ID**.

### 7. Spuštění

```bash
npm start
```

Když v konzoli uvidíš `Registered 13 slash commands`, je hotovo. Bot do textového kanálu sám připne nápovědu. Připoj se do hlasového kanálu a napiš `/pust` a název filmu.

### 8. Automatické spouštění (Windows)

Aby bot naběhl sám po startu počítače a po pádu se restartoval, spusť jednou v PowerShellu ve složce bota:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-task.ps1
```

Na Linuxu použij třeba službu systemd nebo `pm2`.

## Příkazy

| Příkaz | Co dělá |
| --- | --- |
| `/pust film [od] [zvuk] [titulky]` | pustí film nebo díl; `od` = `1:20:00`, `45` (minut) nebo `0` (od začátku) |
| `/pauza`, `/pokracuj` | pozastaví / pustí dál |
| `/posun cas` | `1:20:00` = na čas, `+5` / `-2` = o minuty, `+30s` = o sekundy |
| `/zvuk stopa`, `/titulky stopa` | změní zvukovou stopu nebo titulky za běhu |
| `/filmy [zanr] [rok] [cesky] [razeni] [strana]` | seznam filmů s filtry, film jde pustit z nabídky |
| `/serialy [strana]` | seriál → série → díl |
| `/videli [strana]` | historie kina, nedokoukané jde pustit dál, záznamy jde odebrat z nabídky 🗑 |
| `/zapsat film [kdy] [skoncili]` | ručně zapíše do historie, co jste viděli jinde; `kdy` = `včera`, `28.10.`, `28.10. 21:30`; `skoncili` = `1:20:00` (prázdné = dokoukáno) |
| `/hraje` | co hraje a v jakém čase |
| `/stop`, `/odejdi` | zastaví / zastaví a odejde z hovoru |

Pod zprávou o přehrávání jsou tlačítka **−1 min · pauza · +1 min · +10 min · stop**. Když všichni odejdou z hovoru, kino po 2 minutách přestane vysílat, bez přehrávání se po 5 minutách odpojí.

## Když něco nejde

| Problém | Řešení |
| --- | --- |
| `Missing BOT_TOKEN in .env` | `.env` chybí nebo není vyplněný, viz krok 6 |
| Příkazy se v Discordu neukazují | bot nebyl pozván se scope `applications.commands`, nebo restartuj Discord (Ctrl+R) |
| Nápověda se nepřipnula | bot nemá v textovém kanálu oprávnění *Pin Messages* |
| Film se nespustí, chyba ffmpeg | ověř `FFMPEG_PATH`; bez Intel grafiky nastav `VIDEO_ENCODER=libx264` a `HW_DECODE=0` |
| Obraz se trhá, zvuk jde | počítač nestíhá: sniž `VIDEO_BITRATE` nebo `VIDEO_HEIGHT`, nebo zapni kódování na grafice |
| HDR film je vybledlý | ffmpeg nemá filtr `zscale`, stáhni „full“ build |
| Kino navazuje od divného místa | nastav `JELLYFIN_USER`, jinak sdílí pozice s administrátorem |

Log běžícího bota je v `runtime.log` (při automatickém spouštění), jinak v konzoli.

## Nástroje pro ladění

| Příkaz | Co dělá |
| --- | --- |
| `node tools/jellyfin-check.mjs "název"` | ukáže, co bot vidí v Jellyfinu (stopy, titulky) |
| `node tools/selftest.mjs text` | vytvoří testovací video a projede jím celý řetězec ffmpeg → stream, bez Discordu |
| `node tools/stream-bench.mjs "název"` | změří, jak rychle počítač film převádí (musí být víc než 1×) |
| `node tools/live-test.mjs "název" 30` | pustí film na 30 s do hlasového kanálu a měří odesílání (předtím zastav běžícího bota) |

## Technické poznámky

- **Posun a pauza** spouští ffmpeg znovu od nové pozice. Aby divákům neprobleskl rozbitý obraz, bot posune časové značky RTP o skutečnou mezeru, zahodí zbytky staré relace a počká na celý snímek.
- **Ztracené pakety** se posílají znovu na žádost diváka (NACK). Bot divákům povoluje vyrovnávací paměť až 500 ms, aby opravené pakety stihly dorazit a obraz nezamrzal.
- **Windows** standardně tiká časovači po 15,6 ms, což nestačí na plynulé odesílání videa. Bot si proto přes `koffi` vyžádá rozlišení 1 ms.
- Streamování obstarává knihovna [@dank074/discord-video-stream](https://github.com/dank074/Discord-video-stream).

## Licence

[MIT](LICENSE)
