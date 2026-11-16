# Rezepte

Web-App zum Speichern von Rezepten aus Instagram, Facebook, TikTok & Co.
Claude liest Link, Beschreibungstext und Screenshots aus und speichert:

- Titelbild (Screenshot vom fertigen Gericht)
- Zutaten mit Mengen
- Kalorien, Eiweiß, Kohlenhydrate, Fett (pro Portion und gesamt)
- Zubereitungsschritte

**App:** https://my-project-26.github.io/Rezepte/

## Einrichtung (iPhone)

1. Seite in Safari öffnen → ⚙︎ → Claude-API-Key eintragen (von https://console.anthropic.com/settings/keys).
2. ⚙︎ → „Teilen-Menü auf dem iPhone einrichten“ – dort steht Schritt für Schritt, wie du den Kurzbefehl **„Rezept speichern“** anlegst.
3. In Instagram/Facebook: **Teilen → Rezept speichern**.

Kurz: Der Kurzbefehl empfängt URLs und Text aus dem Share-Sheet, codiert sie (*URL codieren*) und öffnet
`https://my-project-26.github.io/Rezepte/?share=<codierter Text>`.

## Technik

- Reines HTML/CSS/JS, kein Build-Schritt – GitHub Pages liefert die Dateien direkt aus.
- Rezepte und Bilder liegen in IndexedDB im Browser (nur auf dem Gerät). Export/Import als JSON unter ⚙︎.
- Der API-Key liegt nur im `localStorage` des Geräts und wird ausschließlich an `api.anthropic.com` gesendet.
- Claude-Aufruf über das offizielle `@anthropic-ai/sdk` (per jsDelivr), Modell standardmäßig `claude-opus-5-5`,
  strukturierte Ausgabe per JSON-Schema, optional Web-Fetch/-Search, um den Beitrag oder das verlinkte Blog-Rezept zu lesen.
