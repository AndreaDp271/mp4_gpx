# GPX / Video Sync

Web app statica (HTML/CSS/JS puro, nessuna build) che ritaglia una traccia GPX esterna
(Garmin, Strava, telefono, ecc.) esattamente sulla durata di un video, allineando i timestamp.

Tutto avviene **client-side**, nel browser: nessun file viene caricato su un server. Il video
può essere anche molto grande (GB) perché viene letto tramite `File.slice()` — vengono
scaricati in memoria solo i pochi byte necessari a trovare e leggere il box `moov` dell'MP4,
mai l'intero file.

Include anche un'**anteprima video** riproducibile direttamente in pagina e una **mappa**
(Leaflet + tile OpenStreetMap) con la traccia completa, il tratto coperto dal video evidenziato,
e un marcatore che avanza in tempo reale seguendo la posizione GPS mentre il video viene
riprodotto — utile per verificare a occhio che la sincronizzazione sia corretta prima di
scaricare il file ritagliato.

## Come funziona

1. **Video**: l'app scandisce i box di livello superiore del contenitore MP4 (`ftyp`, `mdat`,
   `moov`, ...) leggendo solo i loro header, individua `moov` e ne legge il contenuto per
   estrarre da `mvhd` l'orario di creazione (UTC) e la durata esatta. Se il nome del file segue
   una convenzione tipo action-cam (`..._YYYYMMDDHHMMSS_...`), viene mostrato anche quello come
   riferimento incrociato (in ora locale della camera).
2. **GPX**: il file viene parsato interamente in memoria (è testo, tipicamente pochi MB) e i
   trackpoint vengono ordinati per timestamp.
3. **Ritaglio**: la traccia viene tagliata sulla finestra `[inizio video, inizio video +
   durata]`. Se i timestamp reali del GPX non coincidono esattamente con i bordi della
   finestra, viene inserito un punto **interpolato linearmente** (lat/lon/elevazione e i campi
   numerici delle estensioni, es. frequenza cardiaca) esattamente sul secondo di inizio/fine,
   così il tracciato copre l'intera durata del video senza sfasamenti.
4. Un campo **offset di sincronizzazione** (in secondi, anche frazionari) permette di
   correggere manualmente un eventuale disallineamento tra l'orologio della camera e quello
   del dispositivo GPS.
5. **Mappa e anteprima**: appena il GPX è caricato, l'intera traccia viene disegnata su una
   mappa Leaflet/OpenStreetMap; il tratto corrispondente alla finestra video corrente viene
   evidenziato e si aggiorna a ogni modifica di inizio/durata/offset. Riproducendo l'anteprima
   video, un marcatore avanza sulla mappa nella posizione interpolata corrispondente
   all'istante corrente — un modo rapido per accorgersi visivamente di un eventuale
   disallineamento prima ancora di scaricare il file.

## Uso

Nessuna build necessaria: apri semplicemente [index.html](index.html) nel browser, oppure
pubblica la cartella con GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).

1. Carica il video: inizio e durata vengono precompilati automaticamente.
2. Carica il GPX: viene mostrato l'intervallo temporale coperto.
3. Controlla/correggi inizio, durata ed eventuale offset, poi premi "Ritaglia GPX".
4. Scarica il file `.gpx` risultante.

## Limiti noti

- Assume che l'orologio della camera e quello del dispositivo GPS (Garmin, telefono, ecc.)
  siano sincronizzati correttamente (GPS/rete). Non essendoci un riferimento visivo comune, un
  eventuale drift tra i due orologi va corretto manualmente con l'offset di sincronizzazione.
- Il timestamp `creation_time` di `mvhd` è per specifica UTC, ma alcuni encoder scrivono invece
  l'ora locale: se il video risulta "spostato" di un numero intero di ore, prova a correggere
  manualmente il campo "Inizio video".
- Pensato per file MP4 (ISO Base Media File Format). Altri contenitori (MOV è generalmente
  compatibile, altri formati proprietari potrebbero non esserlo) non sono garantiti.
- La mappa richiede una connessione internet (carica Leaflet e le tile OpenStreetMap da CDN
  esterni); il ritaglio del GPX funziona comunque anche offline, la mappa semplicemente non
  compare se non c'è connessione.
- Per video molto grandi la posizione di riproduzione nell'anteprima dipende dal supporto del
  browser/sistema operativo per lo streaming e il seek su file locali di grandi dimensioni;
  l'analisi dei metadati (`mvhd`) e il ritaglio del GPX non sono invece influenzati dalla
  dimensione del file.

## Licenza

MIT — vedi [LICENSE](LICENSE).
