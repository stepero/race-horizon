# Race Horizon

Hrateľný pretekársky prototyp pre PC (prehliadač). Three.js + TypeScript + Vite. Celé rozhranie je po slovensky.

## Spustenie

Potrebuješ Node.js 20+ (vyvíjané na 22).

```bash
npm install          # (ak nechceš sťahovať Chrome pre screenshoty: PUPPETEER_SKIP_DOWNLOAD=1 npm install)
npm run dev          # http://localhost:5173
npm run build        # produkčný build do dist/
npm test             # fyzika, AI, preteky, online
npm run server       # online server (ws://localhost:8787)
npm run dev:all      # hra + online server naraz
```

## Ovládanie

| Zariadenie | Ovládanie |
|---|---|
| Klávesnica | ↑/W plyn · ↓/S brzda a cúvanie · ←→/A D riadenie · Shift/E vyšší stupeň · Ctrl/Q nižší stupeň · C kamera · R návrat na trať · P/Esc pauza · M minimapa |
| Gamepad | ľavá páčka riadenie · RT plyn · LT brzda · A/RB vyšší · X/LB nižší · Y kamera · Start pauza |
| Volant | Nastavenia → Gamepad / Volant → zapnúť a priradiť osi (riadenie, plyn, brzda) otočením/stlačením; páky radenia ako tlačidlá |

V nastaveniach: prevodovka (automatická/manuálna), ABS, trakčná kontrola, asistent riadenia, minimapa, predvolená kamera (spoza auta / kokpit), citlivosť, hlasitosť.

## Stav implementácie

### Etapa 1 – jazdné jadro (hotové)
- Fyzika: model bicykla s prenosom záťaže, aerodynamikou, trením pneumatík (kružnica trenia), ABS/TC, opotrebenie pneumatík, spotreba paliva, poškodenie po kolíziách (vplýva na výkon a je vidieť na aute).
- Počasie: plynulé zmeny aj počas pretekov (Suché / Meniace sa / Dážď), mokrá trať znižuje priľnavosť, dážď a mokrý asfalt vo vizuáli. Denná doba sa nemení.
- 24 tratí (kalendár 2026 + fiktívna Horizon Park), 2026 F1 tímy a jazdci, GT značky (Ferrari, Porsche, Lamborghini, McLaren, Mercedes, BMW, Nissan, Toyota). Modely áut sú **dočasné** (`placeholder: true`).
- AI súperi s nastaviteľnou náročnosťou (Ľahká až Expert); do 30 áut na trati.
- Štartovacie svetlá (červené → zelené, auto sa nehne pred zelenou), pozície, kolá, časy, tabuľka výsledkov po pretekoch.
- Boxy: vjazd vpravo od štartovej rovinky, obmedzovač rýchlosti, výmena pneumatík → doplnenie paliva → oprava (auto stojí), HUD panel servisu.
- HUD: analógový + digitálny rýchlomer s radením vpravo dole, otáčky, palivo, pneumatiky, poškodenie, minimapa so súpermi (prepínateľná), poradie.
- Tréner: malý nenápadný text vpravo hore, vždy len aktuálna správa (spomalenie, šmyk, dážď, palivo, poškodenie, pneumatiky, zastavenie v boxoch).
- Kamera: kokpit / spoza auta (C), zvuk motora (Web Audio).

### Etapa 2 – kariéra (hotová)
- Menu → Kariéra: viac uložených kariér (sloty), profil (meno, prezývka, krajina, avatar), voľba triedy (GT / Formula) a tímu/značky – tím určuje auto.
- Kvalifikácie (pole 20 jazdcov, postúpi prvých 5, raz za sériu a sezónu), šampionáty (10 pretekov, súčet bodov, konečné poradie dáva bonus levelu a mincí), turnaje (4 preteky), voľné opakovateľné preteky a vždy dostupný základný okruh.
- Progresívne odomykanie sérií podľa levelu (0–1000); výhra level pridáva, prehra uberá. Po každých pretekoch sa ukáže zmena levelu, body a mince.
- Mince sa míňajú len na vylepšenia vybraného auta (motor, pneumatiky, brzdy, zadné krídlo, podvozok); cena a účinok sa zobrazujú, vylepšenia sa ukladajú.
- Po sezóne ponuky tímov (tím, značka, auto, cieľ na ďalšiu sezónu) podľa výsledkov a levelu. Tréner určí cieľ sezóny; splnenie dá menšiu odmenu v minciach, nesplnený cieľ možno skúsiť znova.
- Lokálny rebríček s levelmi do 1000 (tvoje kariéry + simulovaní hráči; online rebríček príde s etapou 5).
- Odchod z kariérnych pretekov alebo zatvorenie hry počas nich sa počíta ako odstúpenie (posledné miesto, bez bodov) – nedá sa „načítať späť“.
- Pravidlá a vyváženie sú na jednom mieste: `src/career/rules.ts`; logika bez UI v `src/career/` (testy: `tests/career.test.ts`).
- 24-hodinovka je súčasťou kariéry (viď etapa 4).

### Etapa 3 – otvorené svety (hotová)
- Menu → Otvorený svet: dve procedurálne mapy (Pobrežná magistrála, Horské serpentíny s kopcami), každá ~8–9 km uzavretej cesty, s voliteľnou **civilnou premávkou** (4–30 pomalých áut) alebo bez nej. Počasie ako v pretekoch (aj meniace sa, mokro znižuje priľnavosť).
- Voľná jazda bez štartu, kôl a cieľa; státím ~3 s sa auto dotankuje, opraví a dostane nové pneumatiky (bez boxov).
- Výzvy na mape (žlté body na minimape): šprint na čas, rýchlostná pasca, čistá jazda bez nárazu. Po splnení idú odmeny (level + mince) do aktívnej kariéry; nesplnenú výzvu možno skúsiť znova.
- Z kariéry: dlaždica „Otvorený svet“ v centre kariéry (jazdíš autom svojho tímu s vylepšeniami a odmeny sa ukladajú).
- Minimapa v svete sleduje auto a ukazuje blízke úseky, výzvy a premávku. Mapy sú **dočasné** (`placeholder`), generované v `src/sim/worldMap.ts`, logika v `src/sim/world.ts`.
- Pozn.: preteky v otvorenom svete (proti AI na trase) zatiaľ nie sú – ostávajú okruhové preteky a kariéra.

### Etapa 4 – 24-hodinovka (hotová)
- **24 minút herného času**, 30 áut na trati (zmiešané pole: asi tretina Formuly, zvyšok GT), vyhráva najviac odjazdených kôl; po uplynutí času dokončí každý svoje rozbehnuté kolo.
- **Povinná zastávka v boxoch**: kto ju nesplní, je klasifikovaný ako posledný (diskvalifikácia). Tréner na ňu upozorní, neskôr naliehavejšie. AI si zastávky rozkladá v čase, aby sa box nezahltil.
- Poradie sa vedie aj **v triede** (F1 / GT); výsledková tabuľka ukazuje triedu a tím.
- **V kariére** je 24-hodinovka dostupná **raz za sezónu** (dlaždica v centre kariéry); spotrebuje sa aj pri odstúpení. Odmeny (level, body, mince) sú vyššie než pri bežných pretekoch.
- **Samostatný režim** (Menu → 24-hodinový závod): vlastná trieda, tím, trať, náročnosť a počasie, proti AI. Odmena do najnovšej kariéry je len ~30 % a sezónnu 24-hodinovku nespotrebuje.
- Uviaznuté auto v boxovej uličke sa po pár sekundách vráti na rýchly pruh (opravené zahltenie boxov pri 30 autách).
- Pravidlá: `src/career/career.ts` (`enduranceConfig`, `ENDURANCE_MIN`), jadro `src/sim/race.ts`; testy `tests/endurance.test.ts`.

### Etapa 5 – online (hotová)
**Ako to spustiť**
1. `npm run dev:all` (alebo v dvoch termináloch `npm run dev` a `npm run server`). Server počúva na porte 8787 (`PORT=9000 npm run server` ho zmení); `http://localhost:8787/health` vráti počet miestností a klientov.
2. V hre: Menu → **Online preteky** → adresa servera (predvolene `ws://<počítač stránky>:8787`, dá sa nastaviť aj `?server=ws://adresa:8787`) → **Pripojiť**.
3. **Hra cez LAN:** server aj hru spusti na jednom počítači, ostatní otvoria `http://<IP-tvojho-počítača>:5173` (Vite vypíše „Network“ adresu; ak nie, spusti `npm run dev -- --host`) a povolia firewallu porty 5173 a 8787. Server sa dá spustiť aj na inom stroji – vtedy zadaj jeho adresu v hre.
4. Jeden hráč vytvorí miestnosť (trať, kolá, počasie, trieda, max. hráčov), ostatní vstúpia, vyberú si tím a kliknú „Som pripravený“. Hostiteľ štartuje (min. 2 hráči, všetci pripravení). Po dojazde sa všetci vrátia do miestnosti (výsledky ostanú vedľa chatu).

**Čo funguje:** zoznam a vytváranie miestností, voľba tímu/auta v rámci triedy, pripravenosť, hostiteľ (pri jeho odchode sa prenesie), chat v miestnosti aj počas pretekov (Enter píše, Esc ruší), synchronizácia áut (20 Hz, interpolácia s oneskorením 0,1 s), poškodenie a boxy ostatných hráčov, kolízie s cudzími autami, živé poradie a výsledky, spoločný štart po načítaní trate u všetkých (štartové svetlá), rovnaké počasie podľa spoločného seedu, odchod/odpojenie hráča počas pretekov.

**Ako to funguje:** každý klient simuluje *svoje* auto a posiela jeho stav; server nesimuluje fyziku, len drží miestnosti, riadi štart, preposiela stavy, počíta poradie a validuje všetky vstupy (rozsahy čísel, dĺžky textov, frekvencia správ, limit chatu 6 správ / 8 s). WebSocket vrstva je vlastná (`server/ws.ts`, bez závislostí). Protokol: `src/net/protocol.ts`, miestnosti: `server/lobby.ts`, klient: `src/net/client.ts`, synchronizácia: `src/net/sync.ts`, UI: `src/ui/online.ts`; testy `tests/online.test.ts`.

**Známe obmedzenia (prototyp):**
- **Žiadna ochrana pred podvodom** – server dôveruje polohe a času dojazdu, ktoré hlási klient (validuje len rozsahy). Vhodné pre kamarátov / LAN, nie pre verejný server.
- Každý klient počíta kolíziu len pre svoje auto a cudzie autá berie ako pevnú prekážku, takže náraz sa u oboch hráčov odrazí mierne inak (bez presnej zhody fyziky).
- Dynamické počasie má rovnaký seed, ale beží podľa lokálneho času, takže sa môže medzi hráčmi mierne rozchádzať.
- Online sú len okruhové preteky (bez AI súperov, otvorených svetov a kariérnych odmien); pripojenie je bez šifrovania (`ws://`), za reverzným proxy použi `wss://`.
- Pri výpadku spojenia počas pretekov sa preteky ukončia a vrátiš sa na obrazovku pripojenia.

### Zostáva do ďalších iterácií
Kokpitová kamera (doladenie), rezervní jazdci, preteky proti AI v otvorených svetoch, overenie dynamického počasia v dlhých pretekoch, `npm audit` upozornenia.

## Ladenie

URL parametre: `?quick=<trať>&weather=dry|dynamic|rain&cls=F1|GT&team=<id>&laps=N&opp=N&grid=N&cam=chase|cockpit&auto=1`
Otvorený svet: `?world=world-coast|world-hills&traffic=1|0&n=<počet áut>&weather=...&auto=1`.
24-hodinovka: `?endurance=<trať>&weather=&cls=F1|GT&team=<id>&dur=<sekundy>&cam=&auto=1` (`dur` skracuje čas na test).
(napr. `?quick=spa&cls=GT&team=gt-porsche&laps=2&opp=29&weather=rain`; `auto=1` vedie auto autopilotom.)
Online: `?server=ws://adresa:8787` predvyplní adresu servera.
Snímky obrazovky: `npm run dev` a v druhom termináli `node scripts/screenshot.mjs "<query>" <meno> [čakanie_s]` (voliteľné `CLICK`, `EVAL`).

## Rozšíriteľnosť

- Katalóg áut, tímov, jazdcov a tratí: `src/data/catalog.ts`; trate sa generujú skriptom `scripts/build-tracks.mjs` do `public/tracks/`.
- Licencovaný 3D model: nastav `modelUrl` v katalógu a v `src/render/carModel.ts` vráť scénu s uzlami `wheel_fl/fr/rl/rr` (viď `PLACEHOLDER_NODES`).
- Preklady: `src/i18n/` (zatiaľ len `sk.ts`).
