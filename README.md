# Pistentipp 26/27

Tippspiel für den FIS Ski-Alpin-Weltcup 2026/27 (Damen und Herren, inkl. WM Crans-Montana) als Handy-Web-App (PWA).

- **App:** statische Seite, gehostet mit GitHub Pages. Auf dem Handy öffnen und „Zum Home-Bildschirm“ hinzufügen.
- **Spieler und Tipps:** Supabase (Postgres). Anmeldung mit Gruppencode, Name und 4-stelliger PIN. Tippschluss und das Verbergen fremder Tipps erzwingt die Datenbank.
- **FIS-Daten:** `scripts/fis-sync.mjs` läuft alle 2 Stunden als GitHub-Action, liest Kalender, Startzeiten und Resultate von fis-ski.com und schreibt `data/season.json` sowie die Historie pro Rennort nach `data/venues/`.

## Einrichtung

1. **Supabase:** Projekt anlegen, im *SQL Editor* den Inhalt von `supabase/migrations/20261020000000_init.sql` ausführen. Am Ende zeigt der SQL Editor den zufälligen Gruppencode an.
2. **config.js:** *Project URL* und *publishable key* (Supabase → Project Settings → API) eintragen.
3. **GitHub Secrets** (Repo → Settings → Secrets and variables → Actions): `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` (der *secret key* `sb_secret_…` oder der alte service_role key) anlegen. Damit überträgt der FIS-Abgleich die Startzeiten in die Datenbank.
4. **GitHub Pages:** Repo → Settings → Pages → *Deploy from a branch*, Branch `main`, Ordner `/ (root)`.

## Punkte

| Tipp | richtiger Platz | auf dem Podest | alle drei exakt | Maximum |
|---|---|---|---|---|
| Rennen | 5 | 2 | +5 | 20 |
| WM-Rennen | ×2 | ×2 | ×2 | 40 |
| Disziplinen-Weltcup | 15 | 6 | +10 | 55 |
| Gesamtweltcup | 25 | 10 | +15 | 90 |

Die Werte stehen in `app.js` (`SCORE`).

## Korrekturen

Falls die FIS ein Resultat falsch oder spät liefert: in `data/overrides.json` unter der Renn-ID (FIS-raceid) Felder überschreiben, z. B.

```json
{ "131693": { "podium": ["Name 1", "Name 2", "Name 3"], "status": "done" } }
```

## Lokal

```sh
npm ci
node scripts/fis-sync.mjs      # FIS-Daten holen (HISTORY_SEASONS=1 für einen schnellen Lauf)
python3 -m http.server 8080
```
