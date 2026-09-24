# Брендові reels — @golikov.psychologyst

Цитатні вертикальні відео для Instagram у фірмових кольорах (темно-зелений +
ніжне золото), українською. Рендер покадрово в Chromium, збірка ffmpeg.

Як це робилося і чому саме так — у [SESSION.md](SESSION.md).
Усі налаштування (палітри, шрифти, ритм, градування фото) — у [CLAUDE.md](CLAUDE.md):
Claude Code підхоплює його автоматично, коли працює в цій теці.

## Що всередині

```
index.html        полотно 720x1280: будь-який кадр як renderFrame(t)
spec.js           палітри + сценарії: v1, v2 і серія t1–t5
textures.js       папір, дим, split-tone градування фото, нитка, зерно
tools/shoot.mjs   знімає кадри через Playwright
fonts/            Playfair Display 700 + Montserrat 700 (кирилиця+латиниця), SIL OFL 1.1
assets/           фото + CREDITS.txt з ліцензіями
out/              готові відео (БЕЗ ЗВУКУ — див. нижче), обкладинки, листи палітр
```

## Запуск

```bash
npm i playwright-core ffmpeg-static
python3 -m http.server 8899 --bind 127.0.0.1 &          # з цієї теки

# --v = сценарій (v1, v2, t1..t5), --p = палітра (p1, p2, p3)
node tools/shoot.mjs --v=t2 --p=p1 --out=frames --fps=30 --dur=11.0
# підібрати інше фото без правки spec.js:
node tools/shoot.mjs --v=t2 --p=p1 --photo=assets/wave.jpg --out=try --times=1.5,6.0

ffmpeg -framerate 30 -i frames/f%04d.png -i track.wav \
  -map 0:v -map 1:a -af "afade=t=out:st=8.87:d=0.22" \
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p \
  -profile:v high -level 4.0 -movflags +faststart -c:a aac -b:a 160k reel.mp4
```

## Нове відео

Серія `t1`–`t5` у `spec.js` зібрана через `reelB(фото, [рядки такту 1], [рядки такту 2])`
— новий ролик додається одним таким викликом. Кожен рядок — масив слів:
слова з'являються по одному кожні 0.30 с.

## Чому відео без звуку

Звук у готових роликах був узятий із референсних відео інших авторів — щоб склейки
лягли на їхній біт. Це чужа музика, а репозиторій публічний, тож її тут немає:
ні доріжок, ні відео з нею. Перед публікацією додай трек із бібліотеки Instagram —
сітка 0.30 с дорівнює 100 BPM і лягає майже на будь-що.

## Ліцензії

- Фото: CC0 / ліцензія Unsplash / ліцензія Pexels — комерційне використання без атрибуції.
  Джерело кожного кадру — `assets/CREDITS.txt`.
- Шрифти: SIL Open Font License 1.1 — `fonts/OFL-*.txt`.
- Нитка на `meadow.jpg` домальована в рендерері (`drawThread`), це не частина знімка.
