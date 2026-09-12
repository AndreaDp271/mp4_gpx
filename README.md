# GPX / Video Sync

Web app statica (HTML/CSS/JS puro, nessuna build, nessuna dipendenza server) per allineare
una traccia GPX esterna (Garmin, Strava, telefono, app di navigazione...) a un video girato
nello stesso momento — action cam, drone, dashcam, qualsiasi MP4.

Tutto avviene **client-side**, nel browser: nessun file viene caricato su un server. Il video
può essere anche molto grande (più GB) perché viene letto tramite `File.slice()` — in memoria
finiscono solo i pochi byte necessari a leggere gli header dei box MP4, mai l'intero file.

L'interfaccia rileva automaticamente la lingua del browser (italiano o inglese, con l'inglese
come ripiego per qualunque altra lingua) e può essere forzata manualmente dal menu in alto a
destra; c'è anche un tema chiaro/scuro esplicito, oltre a quello automatico da sistema.

Include anche un'**anteprima video** e una **mappa** (Leaflet, con vista stradale OpenStreetMap
o satellitare Esri World Imagery), affiancate in due riquadri 16:9. La mappa mostra la traccia
completa, il tratto coperto dal video evidenziato, e un marcatore che avanza in tempo reale
seguendo la posizione GPS mentre il video viene riprodotto (anche da fermo, spostando il campo
offset) — utile per verificare a occhio che la sincronizzazione sia corretta prima di scaricare
qualunque file. Un selettore di velocità (fino a 0.1×) permette di rallentare la riproduzione
per affinare l'offset fotogramma per fotogramma.

## Perché esiste

I tool di editing/telemetria in circolazione di solito costringono a scegliere tra due estremi:
o la fotocamera scrive già il GPS al suo interno (GoPro, Insta360...) e allora tutto "funziona
e basta", oppure il GPS è su un file GPX separato e per usarlo servono editor esterni, script,
o servizi cloud a cui caricare i propri file. Questo progetto copre il caso di mezzo — **un
video "muto" + un GPX esterno** — offrendo tre modi diversi di combinarli, scegliendo quello
più adatto a dove poi userai il risultato, senza mai lasciare il browser:

1. **Ritaglia il GPX** sulla durata del video → il modo più semplice, un `.gpx` più piccolo
   pronto per qualunque editor o overlay di telemetria che accetti GPX.
2. **Correggi l'orario del video** nei suoi stessi metadati MP4 → utile quando serve che sia il
   *video* a "sapere" quando è iniziato per davvero (es. per un tool che allinea da solo video e
   GPX in base al loro orario), lasciando il GPX intero e intatto.
3. **Incorpora il GPS nel video** come una vera traccia **CAMM** (lo standard aperto che Google
   ha definito per Street View, usato anche da Insta360/Ricoh Theta e letto nativamente da
   [Mapillary](https://www.mapillary.com/)) → il video diventa un unico file autosufficiente,
   senza bisogno di portarsi dietro il GPX, e senza alcuna ricodifica di video/audio.

## Come funziona

1. **Video**: l'app scandisce i box di livello superiore del contenitore MP4 (`ftyp`, `mdat`,
   `moov`, ...) leggendo solo i loro header, individua `moov` e ne legge il contenuto per
   estrarre da `mvhd` l'orario di creazione (UTC) e la durata esatta. Se il nome del file segue
   una convenzione tipo action-cam (`..._YYYYMMDDHHMMSS_...`), viene mostrato anche quello come
   riferimento incrociato (in ora locale della camera).
2. **GPX**: il file viene parsato interamente in memoria (è testo, tipicamente pochi MB) e i
   trackpoint vengono ordinati per timestamp.
3. Un campo **offset di sincronizzazione** (in secondi, anche frazionari) corregge un eventuale
   disallineamento tra l'orologio della camera e quello del dispositivo GPS; viene mostrato
   anche in minuti/secondi e come orario video risultante, per capire a colpo d'occhio quanto
   si sta spostando la finestra.
4. **Mappa e anteprima**: appena il GPX è caricato, l'intera traccia viene disegnata su una
   mappa Leaflet; il tratto corrispondente alla finestra video corrente viene evidenziato e si
   aggiorna a ogni modifica di inizio/durata/offset. Riproducendo l'anteprima video, un
   marcatore avanza sulla mappa nella posizione interpolata corrispondente all'istante corrente.
5. **Esportazione**, tre strade indipendenti (vedi sopra "Perché esiste" per quando usare quale):
   - *Ritaglio GPX*: la traccia viene tagliata sulla finestra `[inizio, inizio + durata]`,
     inserendo un punto **interpolato linearmente** (lat/lon/elevazione e i campi numerici
     delle estensioni, es. frequenza cardiaca) esattamente sul secondo di inizio/fine.
   - *Correzione orario video*: il campo `creation_time` del box `mvhd` viene sovrascritto **in
     place**, byte per byte, con l'orario corretto — nessuna ricodifica, nessuno spostamento di
     dati, perché il campo ha dimensione fissa.
   - *Traccia CAMM*: viene costruita una nuova traccia MP4 (`tkhd`/`mdia`/`stbl`...) con un
     campione GPS (`MIN_GPS`, lat/lon/quota) per ogni punto del GPX nella finestra selezionata,
     e aggiunta in coda al file. Funziona senza ricodifica solo quando il box `moov` è già
     l'ultimo del file (il layout tipico di GoPro/DJI/action cam, che scrivono `moov` solo a
     fine registrazione): in quel caso, far crescere `moov` non sposta nessun dato video/audio
     esistente, quindi tutti gli offset restano validi. Se invece il file è "faststart" (`moov`
     prima di `mdat`, tipico di video passati per un editor), l'app lo segnala invece di
     rischiare di produrre un file corrotto — vedi [Limiti noti](#limiti-noti).

## Uso

Nessuna build necessaria: apri semplicemente [index.html](index.html) nel browser, oppure
pubblica la cartella con GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).

1. Carica il video: inizio e durata vengono precompilati automaticamente dai metadati MP4.
2. Carica il GPX: viene mostrato l'intervallo temporale coperto.
3. Riproduci l'anteprima e regola l'offset finché il marcatore sulla mappa non coincide con la
   posizione reale visibile nel video (rallenta il player se serve precisione al fotogramma).
4. Scegli una delle tre esportazioni in fondo alla pagina, in base a cosa userai dopo:

   | Vuoi... | Usa |
   |---|---|
   | Un `.gpx` più piccolo da dare in pasto a un editor/overlay esterno | **Ritaglia GPX** |
   | Che il *video* riporti l'orario giusto, GPX intero | **Correggi orario video** |
   | Un unico file MP4 con GPS incorporato (letto da Mapillary & co.) | **Incorpora traccia GPS (CAMM)** |

### Caricare su Mapillary

Il caso d'uso che ha spinto ad aggiungere l'incorporazione CAMM: Mapillary riconosce
nativamente solo tracce **GPMF** (GoPro), **CAMM** o **BlackVue** incorporate nel video, oppure
un GPX esterno associato manualmente. Due strade, entrambe coperte da questo strumento:

- **Con l'Uploader desktop (GUI, nessuna riga di comando)**: usa "Ritaglia GPX" per ottenere un
  `.gpx` che copre esattamente l'inizio/fine del video (requisito esplicito dell'Uploader), poi
  nell'app aggiungi il video e usa la sua opzione "Add GPX file" per associarci il file
  ritagliato.
- **Con `mapillary_tools` da riga di comando**, o se preferisci un unico file: usa "Incorpora
  traccia GPS (CAMM)" e carica direttamente l'MP4 risultante — Mapillary lo riconosce come se
  fosse stato girato con una fotocamera che registra GPS di suo.

## Limiti noti

- Assume che l'orologio della camera e quello del dispositivo GPS (Garmin, telefono, ecc.)
  siano sincronizzati correttamente (GPS/rete). Non essendoci un riferimento visivo comune, un
  eventuale drift tra i due orologi va corretto manualmente con l'offset di sincronizzazione —
  usando l'anteprima video+mappa e, se serve, rallentando la riproduzione per affinarlo.
- Il timestamp `creation_time` di `mvhd` è per specifica UTC, ma alcuni encoder scrivono invece
  l'ora locale: se il video risulta "spostato" di un numero intero di ore, prova a correggere
  manualmente il campo "Inizio video".
- **L'incorporazione CAMM richiede che `moov` sia l'ultimo box del file** (vero per la maggior
  parte delle action cam, non per i file "faststart" con `moov` in testa, comuni quando un video
  è passato per un editor). Se il tuo file ha questo layout, l'app te lo segnala e propone
  l'alternativa: ri-muxare con `ffmpeg -i input.mp4 -c copy output.mp4` (senza
  `-movflags faststart`, che sposterebbe `moov` nella direzione sbagliata) per spostare `moov`
  in coda, oppure usare "Correggi orario video" + GPX esterno invece.
- Pensato per file MP4 (ISO Base Media File Format). Altri contenitori (MOV è generalmente
  compatibile, altri formati proprietari potrebbero non esserlo) non sono garantiti.
- La mappa richiede una connessione internet (carica Leaflet e le tile OpenStreetMap/Esri da
  CDN esterni); ritaglio GPX, correzione orario e incorporazione CAMM funzionano comunque anche
  offline — la mappa semplicemente non compare se non c'è connessione.
- Per video molto grandi la posizione di riproduzione nell'anteprima dipende dal supporto del
  browser/sistema operativo per lo streaming e il seek su file locali di grandi dimensioni;
  l'analisi dei metadati, il ritaglio del GPX e l'incorporazione CAMM non sono invece
  influenzati dalla dimensione del file.

## Licenza

MIT — vedi [LICENSE](LICENSE).
